// Stack metadata for `docker-sock-proxy`.
//
// Exposes a filtered, unauthenticated Docker API to the containers on its own internal network,
// `hl-docker-api`, so they never mount /var/run/docker.sock themselves. Its compose file creates
// that network; a consumer stack joins it as external and deploys after this one. It is never on
// `proxy`, which every container behind Traefik shares. No web UI (no domain, no
// `requires: ["traefik"]`). Nothing is configurable: the allowed endpoints are fixed in
// `compose.yml` (see the README's security note).

import type { StackMeta } from "@rostok/cli"

export default {
  name: "docker-sock-proxy",
  description: "Filtered Docker API for containers that need it (tecnativa/docker-socket-proxy)",
  category: "infra",
  variables: [
    {
      key: "DOCKER_SOCK_PROXY_IMAGE_TAG",
      default: "latest",
      required: false,
    },
  ],
} satisfies StackMeta
