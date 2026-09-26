// Stack metadata for `stalwart`.
//
// This stack is not in the bundled catalog yet (cli/catalog.ts), so
// `variables` is still empty and `rostok stack add` doesn't offer it.
// Deploy reads this file from a project's own `stacks/stalwart/` for
// `fileMounts` alone (#258): the `cert-sync` sidecar mounts Traefik's
// `acme.json` read-only. It is a file, so deploy must never mkdir or
// chown it, only check that Traefik has already written it.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "stalwart",
  description:
    "Self-hosted mail server (Stalwart) with Let's Encrypt certificates synced from Traefik",
  requires: ["traefik"],
  variables: [],
  fileMounts: ["traefik/letsencrypt/acme.json"],
} satisfies StackMeta
