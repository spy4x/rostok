// Stack metadata for `docker-registry`.
//
// Traefik publishes the web UI at `registry.${DOMAIN}`, and the web UI
// forwards `/v2` to the registry, so the whole registry API is on that
// public address. The registry therefore asks for a login itself:
// DOCKER_REGISTRY_USER and DOCKER_REGISTRY_PASSWORD, which `before.deploy.ts`
// turns into the htpasswd file (a bcrypt hash) the registry reads. Only the
// hook reads the two keys; no container gets the plain password.
// Server-level keys are not declared here (see cli/server-keys.ts).

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

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
    {
      key: "DOCKER_REGISTRY_USER",
      question: "Registry login user name?",
      default: "admin",
      required: true,
    },
    {
      key: "DOCKER_REGISTRY_PASSWORD",
      question: "Registry login password?",
      default: () => generatePassword(24),
      required: true,
      secret: true,
    },
  ],
} satisfies StackMeta
