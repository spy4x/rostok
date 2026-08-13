// after.deploy.ts for pangolin stack — populate the
// `pangolin_pangolin-traefik` named volume from `stacks/pangolin/traefik/`.
//
// Background: the deploy script copies the traefik/ configs to cloudlab's
// filesystem (~/cloudlab/apps/stacks/pangolin/traefik/), but the
// pangolin-traefik container reads from the `pangolin_pangolin-traefik`
// named volume (mapped to /etc/traefik). Docker compose doesn't sync
// files into named volumes; only the initial contents of the volume
// (created on first `docker compose up`) are persisted.
//
// Result without this hook: empty traefik volume → no static config
// loaded → no LE cert, no badger middleware, no routes. The gerbil
// Traefik responds to SNI on 443 with a default self-signed cert, and
// the connection is closed (TLS error) since the cert doesn't match
// the SNI. Manifests as `tunnel-cloud.antonshubin.com` returning a
// certificate error in the browser.
//
// With this hook: after every `deno task deploy cloud pangolin`,
// we copy stacks/pangolin/traefik/*.yml into the volume and restart
// hl-pangolin-traefik so it picks up the new configs.

import { log, success, runCommand } from "../../scripts/+lib.ts"

const SSH_ADDRESS = Deno.env.get("SSH_ADDRESS")
if (!SSH_ADDRESS) {
  throw new Error("SSH_ADDRESS not set in env")
}

log("Populating pangolin_pangolin-traefik volume from stacks/pangolin/traefik/...")

const copyCmd = [
  "docker run --rm",
  "-v pangolin_pangolin-config:/src:ro",
  "-v pangolin_pangolin-traefik:/dst",
  "--user 0:0",
  `alpine sh -c 'rm -f /dst/* && cp /src/traefik/* /dst/'`,
].join(" ")

const copyResult = await runCommand(["ssh", SSH_ADDRESS, copyCmd])
if (!copyResult.success) {
  throw new Error(`Failed to copy traefik configs into volume: ${copyResult.error}`)
}
success("traefik configs copied into pangolin_pangolin-traefik volume")

log("Restarting hl-pangolin-traefik to load new configs...")
const restartResult = await runCommand([
  "ssh",
  SSH_ADDRESS,
  "docker restart hl-pangolin-traefik",
])
if (!restartResult.success) {
  throw new Error(`Failed to restart hl-pangolin-traefik: ${restartResult.error}`)
}
success("hl-pangolin-traefik restarted with Traefik configs loaded")
