// Stack metadata for `github-mcp`.
//
// github-mcp-server behind a small HTTP wrapper (Streamable HTTP), built from the stack's own
// Dockerfile. Internal only: no Traefik route, so no domain and no `requires: ["traefik"]`.
// Other containers on the `proxy` network reach it as `http://hl-github-mcp:3000`.
//
// GITHUB_MCP_TOKEN comes from outside (a personal access token), so it has no default: `stack add`
// asks for it. GITHUB_MCP_VERSION is the release tag the Dockerfile builds; its default equals
// compose's fallback.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "github-mcp",
  description: "GitHub MCP server over Streamable HTTP for AI assistants",
  category: "ai",
  variables: [
    {
      key: "GITHUB_MCP_TOKEN",
      question: "GitHub personal access token (repo and read:user scopes at least)?",
      required: true,
      secret: true,
    },
    {
      key: "GITHUB_MCP_TOOLSETS",
      question: "GitHub tool groups to enable (comma-separated, or all)?",
      default: "all",
      required: false,
    },
    {
      key: "GITHUB_MCP_VERSION",
      default: "v1.5.0",
      required: false,
    },
  ],
} satisfies StackMeta
