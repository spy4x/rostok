// after.deploy.ts for traefik stack — restart hl-traefik so it re-reads
// the .htpasswd usersFile. Traefik caches the basicAuth middleware at
// startup; file changes alone don't reload it.

import { restartRemoteContainer } from "../../scripts/+lib.ts"

await restartRemoteContainer("hl-traefik")
