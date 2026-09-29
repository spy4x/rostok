// Stack metadata for `docker-sock-proxy`.
//
// Exposes a filtered, unauthenticated Docker API to other containers on the `proxy` network, so
// they never mount /var/run/docker.sock themselves. No web UI (no domain, no
// `requires: ["traefik"]`); the `proxy` network is created by `rostok deploy`. Nothing is
// configurable: the allowed endpoints are fixed in `compose.yml` (see the README's security note).

import type { StackMeta } from "@rostok/cli"

export default {
  name: "docker-sock-proxy",
  description: "Filtered Docker API for containers that need it (tecnativa/docker-socket-proxy)",
  category: "infra",
  variables: [],
} satisfies StackMeta
