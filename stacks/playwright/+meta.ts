// Stack metadata for `playwright`.
//
// Playwright browser server plus an MCP proxy on the shared `proxy` network, for Open WebUI
// and other agents. Nothing is exposed through Traefik and compose reads no stack variable.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "playwright",
  description: "Playwright browser server and MCP proxy for AI agents",
  category: "tools",
  variables: [],
} satisfies StackMeta
