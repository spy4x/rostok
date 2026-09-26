// Stack metadata for `mirotalk`.
//
// This stack is not in the bundled catalog yet (cli/catalog.ts), so
// `variables` is still empty and `rostok stack add` doesn't offer it.
// Deploy reads this file from a project's own `stacks/mirotalk/` for
// `fileMounts` alone (#258): the `mirotalk-cert-extract` sidecar mounts Traefik's
// `acme.json` read-only. It is a file, so deploy must never mkdir or
// chown it, only check that Traefik has already written it.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "mirotalk",
  description: "Peer-to-peer video calls with a bundled TURN relay (MiroTalk P2P + coturn)",
  requires: ["traefik"],
  variables: [],
  fileMounts: ["traefik/letsencrypt/acme.json"],
} satisfies StackMeta
