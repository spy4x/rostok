// Guards the bearer token wiring in compose.yml (spy4x/rostok#347).

import { assertEquals } from "@std/assert"
import { parse } from "yaml"

interface Compose {
  services: Record<string, { environment: string[] }>
}

const compose = parse(
  await Deno.readTextFile(new URL(`./compose.yml`, import.meta.url)),
) as Compose

Deno.test("caldav-mcp: compose requires CALDAV_MCP_TOKEN instead of running unauthenticated", () => {
  // caldav-mcp turns authentication off when MCP_BEARER_TOKEN is empty, so
  // compose must fail (`:?`) rather than pass an empty or fixed value.
  const token = compose.services[`caldav-mcp`].environment
    .filter((entry) => entry.startsWith(`MCP_BEARER_TOKEN=`))
  assertEquals(token, [`MCP_BEARER_TOKEN=\${CALDAV_MCP_TOKEN:?}`])
})
