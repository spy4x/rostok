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
// see its module comment for the SSH_PORT default-22 decision) instead
// of parsing SSH_ADDRESS itself (#229) — this hook used to hand the raw
// address straight to `ssh`, which read "host:port" as a literal,
// unresolvable hostname whenever SSH_ADDRESS carried a port.

/** `[user@]host` — no brackets: ssh gets host and -p <port> as separate argv slots. */
function targetHost(host: string, user: string | undefined): string {
  return user ? `${user}@${host}` : host
}

/**
 * Build the argv for `ssh -p <port> -o ConnectTimeout=10 -o
 * BatchMode=yes -- [user@]host docker restart <container>`.
 * `BatchMode=yes` is unconditional here — this hook's own `ssh` call is
 * spawned with `stdin: "null"` below, so it can never answer an
 * interactive prompt anyway. "--" ends ssh's own option parsing before
 * the target — a second guard even though SSH_HOST was already
 * validated (as part of SSH_ADDRESS) before deploy ever set it.
 * Exported for tests — no I/O.
 */
export function buildRestartCommand(
  host: string,
  port: string,
  user: string | undefined,
  container: string,
): string[] {
  return [
    "-p",
    port,
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
  const SSH_PORT = Deno.env.get("SSH_PORT")
  const SSH_USER = Deno.env.get("SSH_USER") || undefined
  if (!SSH_HOST || !SSH_PORT) {
    console.error("after.deploy.ts FAILED: SSH_HOST/SSH_PORT not set")
    Deno.exit(1)
  }

  const args = buildRestartCommand(SSH_HOST, SSH_PORT, SSH_USER, "hl-traefik")

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
