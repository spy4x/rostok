// Guards the bearer token wiring in compose.yml (spy4x/rostok#347).

import { assertEquals } from "@std/assert"
import { parse } from "yaml"

interface Compose {
  services: Record<string, {
    environment: string[]
    labels: string[]
    volumes: string[]
    env_file: { path: string; required: boolean }[]
  }>
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

const service = compose.services[`caldav-mcp`]

Deno.test("caldav-mcp: the Traefik route is off unless the server opts in", () => {
  // A home server must not publish the MCP endpoint just by deploying the stack.
  assertEquals(
    service.labels.filter((label) => label.startsWith(`traefik.enable=`)),
    [`traefik.enable=\${CALDAV_MCP_PUBLIC:-false}`],
  )
})

Deno.test("caldav-mcp: the OAuth env file is optional", () => {
  // Without `required: false`, every server without OAuth would fail to deploy.
  assertEquals(service.env_file, [{
    path: `\${PATH_APPS}/configs/caldav-mcp.env`,
    required: false,
  }])
})

Deno.test("caldav-mcp: the OAuth store lives on a volume at /data", () => {
  // caldav-mcp keeps OAuth grants in /data/oauth.kv; without a volume every redeploy signs
  // connectors out.
  assertEquals(service.volumes, [`\${VOLUMES_PATH}/caldav-mcp:/data:z`])
})
