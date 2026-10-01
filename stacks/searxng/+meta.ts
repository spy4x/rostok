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
  // Redis runs as its own user: deploy must not chown its folder to PUID:PGID (#312).
  keepOwner: ["searxng/redis"],
  variables: [
    {
      key: "SEARXNG_DOMAIN",
      question: "Public domain for SearXNG?",
      default: "search.${DOMAIN}",
      required: true,
    },
    {
      key: "SEARXNG_SECRET_KEY",
      question: "SearXNG secret key (auto-generated)?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
  ],
} satisfies StackMeta
