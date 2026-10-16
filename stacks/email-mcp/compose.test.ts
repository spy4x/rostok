// Guards who can reach the MCP endpoint, which asks callers for no credential
// (spy4x/rostok#143).

import { assertEquals } from "@std/assert"
import { parse } from "yaml"

interface Compose {
  networks: Record<string, { name?: string; external?: boolean }>
  services: Record<string, { networks: string[]; ports?: string[] }>
}

const compose = parse(
  await Deno.readTextFile(new URL("./compose.yml", import.meta.url)),
) as Compose

Deno.test("email-mcp: joins only its own network, never the shared proxy network, and publishes no port", () => {
  assertEquals(compose.services["email-mcp"].ports, undefined)
  assertEquals(compose.services["email-mcp"].networks, ["mcp"])
  // Compose creates it under a fixed name, which Open WebUI's after.deploy.ts connects to.
  assertEquals(compose.networks, { mcp: { name: "hl-email-mcp" } })
})
