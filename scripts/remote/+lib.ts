// Remote container helpers — run commands on the deployed target server
// via SSH using the same SSH_ADDRESS the deploy script uses. Works in
// before.deploy.ts / after.deploy.ts context where SSH_ADDRESS is passed
// via `Deno.env` and the file is executed with --allow-run.

import { log, runCommand, success } from "../+lib.ts"

/**
 * Restart a container on the deploy target. Equivalent to running
 * `ssh $SSH_ADDRESS docker restart <container>` from the dev machine.
 * Use from after.deploy.ts when a service needs to pick up new config
 * that it doesn't hot-reload (Traefik basicAuth usersFile, Gatus YAML).
 */
export async function restartRemoteContainer(container: string): Promise<void> {
  const SSH_ADDRESS = Deno.env.get("SSH_ADDRESS")
  if (!SSH_ADDRESS) {
    throw new Error("SSH_ADDRESS not set")
  }
  log(`Restarting ${container} on ${SSH_ADDRESS}...`)
  const result = await runCommand([
    "ssh",
    SSH_ADDRESS,
    `docker restart ${container}`,
  ])
  if (!result.success) {
    throw new Error(`Failed to restart ${container}: ${result.error}`)
  }
  success(`✓ ${container} restarted`)
}
