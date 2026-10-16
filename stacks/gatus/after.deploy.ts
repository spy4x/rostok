// after.deploy.ts for gatus stack — restart hl-gatus so it picks up the
// new config.yaml. Gatus does not watch its config at runtime.
//
// Self-contained per the deploy hook contract: no import out of this
// stack directory (deploy runs this file from the installed package,
// an https:// URL when installed from JSR, where a relative parent
// import can't resolve).
//
// Uses the SSH_HOST/SSH_PORT/SSH_USER contract keys every hook gets
// (parsed once from SSH_ADDRESS by cli/deploy/hooks.ts's buildHookEnv —
// see its module comment) instead of parsing SSH_ADDRESS itself (#229)
// — this hook used to hand the raw address straight to `ssh`, which
// read "host:port" as a literal, unresolvable hostname whenever
// SSH_ADDRESS carried a port.
//
// SSH_PORT is set ONLY when SSH_ADDRESS carried an explicit port —
// never a default — so `-p` is added only when SSH_PORT is non-empty;
// omitting it otherwise lets ssh consult ~/.ssh/config for a bare alias
// (see cli/deploy/hooks.ts's module comment for why a default-22 would
// have broken an alias with its own non-default Port).
//
// A local server (SSH_ADDRESS=local) has no SSH_HOST: the hook then runs
// `docker restart` on this machine, with no ssh.
//
// #397: it restarts only when config.yml changed since hl-gatus started, so a
// deploy that changes nothing keeps the container running. See needsRestart.

/** `[user@]host` — no brackets: ssh gets host and -p <port> as separate argv slots. */
function targetHost(host: string, user: string | undefined): string {
  return user ? `${user}@${host}` : host
}

/**
 * The deploy target's ssh host, or undefined on a local server. The local path is taken only when
 * deploy says the server is local (SSH_LOCAL=true, set by cli/deploy/hooks.ts, #450): a missing
 * SSH_HOST alone is an error, so a hook run by hand without it never acts on this machine.
 * Exported for tests — no I/O.
 */
export function deployTargetHost(env: (key: string) => string | undefined): string | undefined {
  const host = env("SSH_HOST") || undefined
  if (host !== undefined || env("SSH_LOCAL") === "true") return host
  throw new Error(
    "SSH_HOST is not set and SSH_LOCAL is not true: run this hook through rostok deploy",
  )
}

/** Digits only, 1-65535 — the same range cli/server-keys.ts's parseSshAddress enforces. */
function isValidPort(port: string): boolean {
  if (!/^\d+$/.test(port)) return false
  const n = Number(port)
  return n >= 1 && n <= 65535
}

/**
 * Build the argv for `ssh [-p <port>] -o ConnectTimeout=10 -o
 * BatchMode=yes -- [user@]host docker restart <container>`. `port` is
 * omitted from the argv entirely when undefined (SSH_ADDRESS had no
 * explicit port) — a hook must never invent a default port an alias's
 * own ~/.ssh/config might already override. Throws if `port` is set but
 * not a valid 1-65535 port — defense in depth even though SSH_ADDRESS
 * was already validated once before deploy ever set SSH_PORT.
 * `BatchMode=yes` is unconditional here — this hook's own `ssh` call is
 * spawned with `stdin: "null"` below, so it can never answer an
 * interactive prompt anyway. "--" ends ssh's own option parsing before
 * the target — a second guard even though SSH_HOST was already
 * validated (as part of SSH_ADDRESS) before deploy ever set it.
 * Exported for tests — no I/O.
 */
export function buildRestartCommand(
  host: string,
  port: string | undefined,
  user: string | undefined,
  container: string,
): string[] {
  return buildSshArgs(host, port, user, ["docker", "restart", container])
}

/** buildRestartCommand's argv with any remote command `remote` after the target. */
function buildSshArgs(
  host: string,
  port: string | undefined,
  user: string | undefined,
  remote: string[],
): string[] {
  if (port !== undefined && !isValidPort(port)) {
    throw new Error(`invalid SSH_PORT "${port}": expected digits 1-65535`)
  }
  return [
    ...(port !== undefined ? ["-p", port] : []),
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "--",
    targetHost(host, user),
    ...remote,
  ]
}

/**
 * The program and argv that restart `container` on the deploy target:
 * `docker restart` on this machine when `host` is unset (a local server),
 * `ssh ... docker restart` otherwise. Throws like buildRestartCommand on a
 * bad `port`. Exported for tests — no I/O.
 */
export function buildTargetRestart(
  host: string | undefined,
  port: string | undefined,
  user: string | undefined,
  container: string,
): { cmd: string; args: string[] } {
  if (!host) return { cmd: "docker", args: ["restart", container] }
  return { cmd: "ssh", args: buildRestartCommand(host, port, user, container) }
}

/**
 * Single-quote `value` for a POSIX shell: the one character a single-quoted string cannot hold,
 * `'`, is closed, escaped and reopened.
 */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * The shell script that prints the two facts the restart decision needs, one per line:
 * `ctime=<seconds>` of `file` (its inode change time, empty when the file is missing) and
 * `started=<StartedAt>` of `container` (empty when it does not exist). Both come from the deploy
 * target's own clock. Exported for tests — no I/O.
 */
export function buildStatusScript(file: string, container: string): string {
  return `echo "ctime=$(stat -c %Z -- ${shQuote(file)} 2>/dev/null)"; ` +
    `echo "started=$(docker inspect -f '{{.State.StartedAt}}' ${shQuote(container)} 2>/dev/null)"`
}

/** Seconds since the epoch of a Docker `StartedAt` (RFC 3339, nanoseconds), or undefined. */
function parseStartedAt(value: string): number | undefined {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d+)?(Z|[+-]\d\d:\d\d)$/.exec(value)
  if (!match) return undefined
  const ms = Date.parse(`${match[1]}${match[2]}`)
  return Number.isNaN(ms) ? undefined : ms / 1000
}

/**
 * Whether `container` must restart to load `file`, from buildStatusScript's output. It must when
 * the file changed (its ctime) in the same second the container started or later: rsync gives a
 * changed file a new inode on every deploy, while deploy's before-hook leaves an unchanged file's
 * mtime as the server's, so rsync skips it and its ctime stays older than the container. Anything
 * missing or unreadable means restart: that is the behaviour before this check existed. Exported
 * for tests — no I/O.
 */
export function needsRestart(statusOutput: string): boolean {
  const values = new Map<string, string>()
  for (const line of statusOutput.split("\n")) {
    const at = line.indexOf("=")
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim())
  }
  const ctimeText = values.get("ctime") ?? ""
  const started = parseStartedAt(values.get("started") ?? "")
  if (!/^\d+$/.test(ctimeText) || started === undefined) return true
  return Number(ctimeText) >= Math.floor(started)
}

/**
 * The program and argv that run `script` on the deploy target: `sh -c` on this machine when `host`
 * is unset (a local server), ssh otherwise. Throws like buildRestartCommand on a bad `port`.
 * Exported for tests — no I/O.
 */
export function buildTargetShell(
  host: string | undefined,
  port: string | undefined,
  user: string | undefined,
  script: string,
): { cmd: string; args: string[] } {
  if (!host) return { cmd: "sh", args: ["-c", script] }
  return { cmd: "ssh", args: buildSshArgs(host, port, user, [script]) }
}

if (import.meta.main) {
  const SSH_PORT = Deno.env.get("SSH_PORT") || undefined
  const SSH_USER = Deno.env.get("SSH_USER") || undefined
  const PATH_APPS = Deno.env.get("PATH_APPS") || undefined

  let restart: { cmd: string; args: string[] }
  let status: { cmd: string; args: string[] } | undefined
  try {
    const SSH_HOST = deployTargetHost((key) => Deno.env.get(key))
    restart = buildTargetRestart(SSH_HOST, SSH_PORT, SSH_USER, "hl-gatus")
    if (PATH_APPS) {
      const script = buildStatusScript(`${PATH_APPS}/stacks/gatus/config.yml`, "hl-gatus")
      status = buildTargetShell(SSH_HOST, SSH_PORT, SSH_USER, script)
    }
  } catch (err) {
    console.error("after.deploy.ts FAILED:", err instanceof Error ? err.message : String(err))
    Deno.exit(1)
  }

  if (status) {
    const checked = await new Deno.Command(status.cmd, {
      args: status.args,
      stdin: "null",
      stdout: "piped",
      stderr: "inherit",
    }).output()
    if (checked.success && !needsRestart(new TextDecoder().decode(checked.stdout))) {
      console.log("config.yml unchanged since hl-gatus started, not restarted")
      Deno.exit(0)
    }
  }

  const result = await new Deno.Command(restart.cmd, {
    args: restart.args,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).output()

  if (!result.success) {
    console.error("after.deploy.ts FAILED: could not restart hl-gatus")
    Deno.exit(1)
  }

  console.log("hl-gatus restarted")
}
