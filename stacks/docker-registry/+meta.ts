// Stack metadata for `docker-registry`.
//
// Web UI routes through Traefik at `registry.${DOMAIN}`. The registry itself is reachable only on the proxy network.
// Server-level keys are not declared here (see cli/server-keys.ts).

import type { StackMeta } from "@rostok/cli"

export default {
  name: "docker-registry",
  description: "Private Docker registry with a web UI (registry:2 + joxit/docker-registry-ui)",
  category: "infra",
  requires: ["traefik"],
  variables: [
    {
      key: "DOCKER_REGISTRY_DOMAIN",
      question: "Public domain for the registry web UI?",
      default: "registry.${DOMAIN}",
      required: true,
    },
  ],
} satisfies StackMeta
