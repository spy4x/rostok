// Stack metadata for `caldav-mcp`.
//
// spy4x/caldav-mcp built from the stack's own Dockerfile: a CalDAV MCP server (events and tasks)
// over HTTP on port 3000. Internal only: no Traefik route, so no domain and no
// `requires: ["traefik"]`. Other containers on the `proxy` network reach it as
// `http://hl-caldav-mcp:3000`.
//
// The three CALDAV_MCP_* keys point at the CalDAV server the operator already runs, so they have
// no default: `stack add` asks for them. The password is secret.
//
// CALDAV_MCP_TOKEN is the bearer token clients send to the HTTP endpoint, generated at `stack add`.
// open-webui sends it through its own OPEN_WEBUI_CALDAV_MCP_TOKEN, set to `${CALDAV_MCP_TOKEN}`.
// compose refuses to start without it, because caldav-mcp turns authentication off when it is empty.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "caldav-mcp",
  description: "CalDAV MCP server for AI assistants: events and tasks (spy4x/caldav-mcp)",
  category: "ai",
  variables: [
    {
      key: "CALDAV_MCP_SERVER_URL",
      question: "CalDAV server URL (e.g. https://cal.example.com)?",
      required: true,
    },
    {
      key: "CALDAV_MCP_USERNAME",
      question: "CalDAV username?",
      required: true,
    },
    {
      key: "CALDAV_MCP_PASSWORD",
      question: "CalDAV password?",
      required: true,
      secret: true,
    },
    {
      key: "CALDAV_MCP_TOKEN",
      question: "Bearer token MCP clients send (auto-generated)?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
  ],
} satisfies StackMeta
