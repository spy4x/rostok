// Guards who can reach the mail tools (spy4x/rostok#143): only Open WebUI reaches the guard, only
// the guard reaches the upstream server, which asks for no credential, and no port is published.

import { assertEquals } from "@std/assert"
import { parse } from "yaml"

interface Compose {
  networks: Record<string, { name?: string; external?: boolean; internal?: boolean }>
  services: Record<
    string,
    { container_name: string; networks: string[]; ports?: string[]; environment?: string[] }
  >
}

const compose = parse(
  await Deno.readTextFile(new URL("./compose.yml", import.meta.url)),
) as Compose

Deno.test("email-mcp: the network Open WebUI joins keeps its name and holds only the guard", () => {
  // Compose creates it under a fixed name, which Open WebUI's after.deploy.ts connects to.
  assertEquals(compose.networks.mcp, { name: "hl-email-mcp" })
  const onIt = Object.keys(compose.services).filter((s) =>
    compose.services[s].networks.includes("mcp")
  )
  assertEquals(onIt, ["email-mcp"])
  // Open WebUI's URL http://hl-email-mcp:9557/mcp reaches the guard.
  assertEquals(compose.services["email-mcp"].container_name, "hl-email-mcp")
  assertEquals(compose.services["email-mcp"].networks, ["mcp", "upstream"])
})

Deno.test("email-mcp: the upstream server is reachable only on an internal network it shares with the guard", () => {
  assertEquals(compose.networks.upstream, { name: "hl-email-mcp-upstream", internal: true })
  // Its other network is its way out to the mail host; no other service joins it.
  assertEquals(compose.networks.egress, { name: "hl-email-mcp-egress" })
  assertEquals(compose.services.upstream.networks, ["upstream", "egress"])
  const onEgress = Object.keys(compose.services).filter((s) =>
    compose.services[s].networks.includes("egress")
  )
  assertEquals(onEgress, ["upstream"])
})

Deno.test("email-mcp: no service is on the shared proxy network or publishes a port", () => {
  for (const [name, service] of Object.entries(compose.services)) {
    assertEquals(service.ports, undefined, name)
    assertEquals(service.networks.includes("proxy"), false, name)
  }
  assertEquals(Object.keys(compose.networks).toSorted(), ["egress", "mcp", "upstream"])
  for (const network of Object.values(compose.networks)) assertEquals(network.external, undefined)
})

Deno.test("email-mcp: compose refuses to start the guard without EMAIL_MCP_TOKEN", () => {
  assertEquals(
    compose.services["email-mcp"].environment?.includes("EMAIL_MCP_TOKEN=${EMAIL_MCP_TOKEN:?}"),
    true,
  )
})
