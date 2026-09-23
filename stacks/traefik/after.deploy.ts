// after.deploy.ts for traefik stack — restart hl-traefik so it re-reads
// the .htpasswd usersFile. Traefik caches the basicAuth middleware at
// startup; file changes alone don't reload it.
//
// Self-contained per the deploy hook contract: no import out of this
// stack directory (deploy runs this file from the installed package,
// an https:// URL when installed from JSR, where a relative parent
// import can't resolve).

// Same rule as cli/server-keys.ts's SSH_ADDRESS_PATTERN, inlined
// because this hook can't import it. An ssh_config alias, host or
// user@host, no spaces, never starting with "-" — which ssh's own
// argument parser would otherwise read as an option (e.g.
// "-oProxyCommand=..." runs a local command).
const SSH_ADDRESS_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._@:-]*$/

/**
 * Build the argv for `ssh <address> -- docker restart <container>`.
 * Throws when `sshAddress` doesn't match SSH_ADDRESS_PATTERN. "--"
 * goes before the address as a second, independent guard: even a
 * value that somehow slipped past the pattern check can't be read as
 * an ssh option once "--" ends option parsing. Exported for tests — no
 * I/O.
 */
export function buildRestartCommand(sshAddress: string, container: string): string[] {
  if (!SSH_ADDRESS_PATTERN.test(sshAddress)) {
    throw new Error(`invalid SSH_ADDRESS "${sshAddress}"`)
  }
  return ["--", sshAddress, "docker", "restart", container]
}

if (import.meta.main) {
  const SSH_ADDRESS = Deno.env.get("SSH_ADDRESS")
  if (!SSH_ADDRESS) {
    console.error("after.deploy.ts FAILED: SSH_ADDRESS not set")
    Deno.exit(1)
  }

  let args: string[]
  try {
    args = buildRestartCommand(SSH_ADDRESS, "hl-traefik")
  } catch (err) {
    console.error("after.deploy.ts FAILED:", err instanceof Error ? err.message : String(err))
    Deno.exit(1)
  }

  const result = await new Deno.Command("ssh", {
    args,
    stdout: "inherit",
    stderr: "inherit",
  }).output()

  if (!result.success) {
    console.error("after.deploy.ts FAILED: could not restart hl-traefik")
    Deno.exit(1)
  }

  console.log("hl-traefik restarted")
}
