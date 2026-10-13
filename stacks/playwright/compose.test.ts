// Guards who can reach the MCP endpoint and what its browser runs as (spy4x/rostok#338).

import { assertEquals } from "@std/assert"
import { parse } from "yaml"

interface Compose {
  networks: Record<string, { name?: string; external?: boolean }>
  services: Record<string, { networks: string[]; ports?: string[] }>
}

const compose = parse(
  await Deno.readTextFile(new URL(`./compose.yml`, import.meta.url)),
) as Compose

const dockerfile = Deno.readTextFileSync(new URL(`./Dockerfile.mcp-proxy`, import.meta.url))

Deno.test("playwright-mcp: joins only its own network, never the shared proxy network, and publishes no port", () => {
  assertEquals(compose.services[`playwright-mcp`].ports, undefined)
  assertEquals(compose.services[`playwright-mcp`].networks, [`mcp`])
  // Compose creates it under a fixed name, which after.deploy.ts connects the client to.
  assertEquals(compose.networks.mcp, { name: `hl-playwright-mcp` })
})

Deno.test("playwright-mcp: the image ends as pwuser, not root", () => {
  const users = dockerfile.split(`\n`).filter((line) => line.startsWith(`USER `))
  assertEquals(users.at(-1), `USER pwuser`)
})
