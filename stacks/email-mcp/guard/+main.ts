// Entry point of the email-mcp guard: `deno serve` runs this file (see the Dockerfile here). The
// handler is in guard.ts; this file only reads its settings from the environment.

import { createGuard, MIN_TOKEN_LENGTH } from "./guard.ts"

/** Where the upstream server listens, on the network only it and the guard share. */
const UPSTREAM_URL = "http://hl-email-mcp-upstream:9557/mcp"

const guard = createGuard({
  token: Deno.env.get("EMAIL_MCP_TOKEN") ?? "",
  allowedUsers: Deno.env.get("EMAIL_MCP_ALLOWED_USERS") ?? "",
  upstream: UPSTREAM_URL,
})

if ((Deno.env.get("EMAIL_MCP_TOKEN") ?? "").length < MIN_TOKEN_LENGTH) {
  console.error(
    `email-mcp guard: EMAIL_MCP_TOKEN is missing or shorter than ${MIN_TOKEN_LENGTH} characters; ` +
      `every request gets 503 until it is set`,
  )
}

export default { fetch: guard } satisfies Deno.ServeDefaultExport
