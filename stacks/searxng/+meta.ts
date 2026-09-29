// Stack metadata for `searxng`.
//
// Meta search engine at `search.${DOMAIN}` behind Traefik. `before.deploy.ts` renders
// `settings.yml` from `searxng-settings.yml` with the secret key below.
//
// Variable shape:
//   - SEARXNG_SECRET_KEY: secret, generated at `stack add`.
//
// Server-level vars (DOMAIN, VOLUMES_PATH, PATH_APPS) intentionally NOT declared here.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "searxng",
  description: "Meta search engine (searxng/searxng)",
  category: "tools",
  requires: ["traefik"],
  variables: [
    {
      key: "SEARXNG_SECRET_KEY",
      question: "SearXNG secret key (auto-generated)?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
  ],
} satisfies StackMeta
