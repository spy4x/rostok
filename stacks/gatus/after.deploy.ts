// after.deploy.ts for gatus stack — restart hl-gatus so it picks up the
// new config.yaml. Gatus does not watch its config at runtime.
//
// Self-contained per the deploy hook contract: no import out of this
// stack directory (deploy runs this file from the installed package,
// an https:// URL when installed from JSR, where a relative parent
// import can't resolve).

// Same parsing rule as cli/server-keys.ts's parseSshAddress, inlined
// because this hook can't import it (it ships and runs standalone, as
// a bare file:// or https:// URL — see the module comment above). An
// ssh_config alias, host, user@host, host:port, user@host:port, a bare
// IPv6 address, or [IPv6]:port, no spaces, never starting with "-" —
// which ssh's own argument parser would otherwise read as an option
// (e.g. "-oProxyCommand=..." runs a local command).
const SSH_HOST_CHARS_PATTERN = /^[A-Za-z0-9_.:-]+$/
/** Same as cli/server-keys.ts's SSH_USER_PATTERN — see its comment. */
const SSH_USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

export interface SshTarget {
  user?: string
  host: string
  port?: number
}

/** Same grammar as cli/server-keys.ts's parseSshAddress — kept in sync by a shared test table. Exported for tests. */
export function parseSshAddress(value: string): SshTarget {
  if (value.startsWith("-")) throw new Error(`invalid SSH_ADDRESS "${value}"`)

  let rest = value
  let user: string | undefined
  const atIdx = rest.indexOf("@")
  if (atIdx !== -1) {
    user = rest.slice(0, atIdx)
    rest = rest.slice(atIdx + 1)
    if (user === "" || !SSH_USER_PATTERN.test(user)) {
      throw new Error(`invalid SSH_ADDRESS "${value}"`)
    }
  }
  if (rest === "") throw new Error(`invalid SSH_ADDRESS "${value}"`)
  if (rest.startsWith("-")) throw new Error(`invalid SSH_ADDRESS "${value}"`)

  let host: string
  let portText: string | undefined

  if (rest.startsWith("[")) {
    const closeIdx = rest.indexOf("]")
    if (closeIdx === -1) throw new Error(`invalid SSH_ADDRESS "${value}"`)
    host = rest.slice(1, closeIdx)
    const after = rest.slice(closeIdx + 1)
    if (after !== "") {
      if (!after.startsWith(":")) throw new Error(`invalid SSH_ADDRESS "${value}"`)
      portText = after.slice(1)
    }
    if (host === "") throw new Error(`invalid SSH_ADDRESS "${value}"`)
  } else {
    const colonCount = rest.split(":").length - 1
    if (colonCount === 0) {
      host = rest
    } else if (colonCount === 1) {
      const idx = rest.indexOf(":")
      host = rest.slice(0, idx)
      portText = rest.slice(idx + 1)
      if (host === "") throw new Error(`invalid SSH_ADDRESS "${value}"`)
    } else {
      const lastColon = rest.lastIndexOf(":")
      const maybeHost = rest.slice(0, lastColon)
      const maybePort = rest.slice(lastColon + 1)
      if (maybeHost.includes("::") && /^\d+$/.test(maybePort)) {
        throw new Error(`invalid SSH_ADDRESS "${value}": bracket the IPv6 address and its port`)
      }
      host = rest
    }
  }

  if (!SSH_HOST_CHARS_PATTERN.test(host)) throw new Error(`invalid SSH_ADDRESS "${value}"`)

  let port: number | undefined
  if (portText !== undefined) {
    if (!/^\d+$/.test(portText)) throw new Error(`invalid SSH_ADDRESS "${value}"`)
    port = Number(portText)
    if (port < 1 || port > 65535) throw new Error(`invalid SSH_ADDRESS "${value}": bad port`)
  }

  return { user, host, port }
}

// Never brackets an IPv6 host: ssh gets the target and -p <port> as
// separate argv slots below, so there's no combined "host:port" string
// for a bare colon to be ambiguous inside.
function targetHost(target: SshTarget): string {
  return target.user ? `${target.user}@${target.host}` : target.host
}

/**
 * Build the argv for `ssh -o ConnectTimeout=10 -o BatchMode=yes [-p
 * <port>] -- <address> docker restart <container>`. Throws when
 * `sshAddress` doesn't parse. `BatchMode=yes` is unconditional here —
 * this hook's own `ssh` call is spawned with `stdin: "null"` below, so
 * it can never answer an interactive prompt anyway. "--" goes before
 * the address as a second, independent guard: even a value that
 * somehow slipped past parsing can't be read as an ssh option once
 * "--" ends option parsing. Exported for tests — no I/O.
 */
export function buildRestartCommand(sshAddress: string, container: string): string[] {
  const target = parseSshAddress(sshAddress)
  const args = ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes"]
  if (target.port !== undefined) args.push("-p", String(target.port))
  args.push("--", targetHost(target), "docker", "restart", container)
  return args
}

if (import.meta.main) {
  const SSH_ADDRESS = Deno.env.get("SSH_ADDRESS")
  if (!SSH_ADDRESS) {
    console.error("after.deploy.ts FAILED: SSH_ADDRESS not set")
    Deno.exit(1)
  }

  let args: string[]
  try {
    args = buildRestartCommand(SSH_ADDRESS, "hl-gatus")
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
    console.error("after.deploy.ts FAILED: could not restart hl-gatus")
    Deno.exit(1)
  }

  console.log("hl-gatus restarted")
}
