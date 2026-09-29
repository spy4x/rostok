// Stack metadata for `watchtower`.
//
// Watchtower pulls newer images for the running containers and restarts
// them. Stateless — no `backup.ts`, no web UI, so no domain and no
// `requires: ["traefik"]`. Reads the Docker socket only.
//
// Variables: just the two resource limits. Server-level vars (PUID, PGID,
// DOCKER_GROUP_ID) are intentionally NOT declared here — same convention
// as filebrowser. See `stacks/filebrowser/+meta.ts`. The image tag is
// pinned in `compose.yml`, not exposed as a variable.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "watchtower",
  description: "Automatic Docker container image updates (nickfedor/watchtower)",
  category: "infra",
  variables: [
    {
      key: "WATCHTOWER_CPU_LIMIT",
      question: "CPU limit for the Watchtower container?",
      default: "0.5",
      required: true,
    },
    {
      key: "WATCHTOWER_MEM_LIMIT",
      question: "Memory limit for the Watchtower container?",
      default: "256M",
      required: true,
    },
  ],
} satisfies StackMeta
