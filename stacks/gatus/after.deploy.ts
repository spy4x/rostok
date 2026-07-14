// after.deploy.ts for gatus stack — restart hl-gatus so it picks up the
// new config.yaml. Gatus does not watch its config at runtime.

import { restartRemoteContainer } from "../../scripts/remote/+lib.ts"

await restartRemoteContainer("hl-gatus")
