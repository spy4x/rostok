// after.deploy.ts for traefik stack — restart hl-traefik so it re-reads
// the .htpasswd usersFile. Traefik caches the basicAuth middleware at
// startup; file changes alone don't reload it.
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

/** `[user@]host` — no brackets: ssh gets host and -p <port> as separate argv slots. */
function targetHost(host: string, user: string | undefined): string {
  return user ? `${user}@${host}` : host
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
    "docker",
    "restart",
    container,
  ]
}

if (import.meta.main) {
  const SSH_HOST = Deno.env.get("SSH_HOST")
  const SSH_PORT = Deno.env.get("SSH_PORT") || undefined
  const SSH_USER = Deno.env.get("SSH_USER") || undefined
  if (!SSH_HOST) {
    console.error("after.deploy.ts FAILED: SSH_HOST not set")
    Deno.exit(1)
  }

  let args: string[]
  try {
    args = buildRestartCommand(SSH_HOST, SSH_PORT, SSH_USER, "hl-traefik")
  } catch (err) {
    console.error("after.deploy.ts FAILED:", err instanceof Error ? err.message : String(err))
    Deno.exit(1)
  }

  const result = await new Deno.Command("ssh", {
    args,
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).output()

  if (!result.success) {
    console.error("after.deploy.ts FAILED: could not restart hl-traefik")
    Deno.exit(1)
  }

  console.log("hl-traefik restarted")
}
