// Stack metadata for `google-maps-mcp`.
//
// mcp-google-map built from the stack's own Dockerfile, speaking Streamable HTTP. Internal only:
// no Traefik route, so no domain and no `requires: ["traefik"]`. Other containers on the `proxy`
// network reach it as `http://hl-google-maps-mcp:3000`.
//
// GOOGLE_MAPS_MCP_API_KEY comes from outside (Google Cloud console), so it has no default:
// `stack add` asks for it. The two optional keys default to compose's own fallbacks.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "google-maps-mcp",
  description: "Google Maps MCP server: places, geocoding, directions, weather",
  category: "ai",
  variables: [
    {
      key: "GOOGLE_MAPS_MCP_API_KEY",
      question: "Google Maps API key (Places API (New) and Routes API enabled)?",
      required: true,
      secret: true,
    },
    {
      key: "GOOGLE_MAPS_MCP_ENABLED_TOOLS",
      question: "Tools to enable (comma-separated names, or * for all)?",
      default: "*",
      required: false,
    },
    {
      key: "GOOGLE_MAPS_MCP_VERSION",
      default: "v0.0.52",
      required: false,
    },
  ],
} satisfies StackMeta
