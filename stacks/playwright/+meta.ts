// Stack metadata for `playwright`.
//
// Playwright browser server on the shared `proxy` network, plus an MCP proxy on a network of its
// own that `after.deploy.ts` connects Open WebUI to. Nothing is exposed through Traefik and
// compose reads no stack variable.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "playwright",
  description: "Playwright browser server and MCP proxy for AI agents",
  category: "tools",
  variables: [],
} satisfies StackMeta
