// Stack metadata for `playwright`.
//
// Playwright browser server and an MCP proxy, both on a network of their own that
// `after.deploy.ts` connects Open WebUI to, never on the shared `proxy` network. Nothing is
// exposed through Traefik and compose reads no stack variable.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "playwright",
  description: "Playwright browser server and MCP proxy for AI agents",
  category: "tools",
  variables: [],
} satisfies StackMeta
