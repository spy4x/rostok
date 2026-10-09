// Guards the bearer token wiring in compose.yml (spy4x/rostok#347).

import { assertEquals, assertMatch } from "@std/assert"
import { parse } from "yaml"

interface Compose {
  services: Record<string, {
    environment: string[]
    labels: string[]
    volumes: string[]
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

Deno.test("caldav-mcp: OAuth settings default to blank, which caldav-mcp reads as off", () => {
  // A server that sets none of them must still deploy, bearer-only.
  assertEquals(
    service.environment.filter((entry) =>
      /^(PUBLIC_URL|OWNER_PASSWORD_HASH|AUTH_PEPPER)=/.test(entry)
    ),
    [
      `PUBLIC_URL=\${CALDAV_MCP_PUBLIC_URL:-}`,
      `OWNER_PASSWORD_HASH=\${CALDAV_MCP_OWNER_PASSWORD_HASH:-}`,
      `AUTH_PEPPER=\${CALDAV_MCP_AUTH_PEPPER:-}`,
    ],
  )
})

Deno.test("caldav-mcp: the image builds a pinned caldav-mcp tag, not a branch", () => {
  // `up --build` reuses a cached `git clone --branch main` layer, so a branch can build stale code.
  const dockerfile = Deno.readTextFileSync(new URL(`./Dockerfile`, import.meta.url))
  assertMatch(dockerfile, /^ARG CALDAV_MCP_VERSION=v\d+\.\d+\.\d+$/m)
  assertMatch(dockerfile, /git clone --depth 1 --branch "\$\{CALDAV_MCP_VERSION\}"/)
})

Deno.test("caldav-mcp: the OAuth store lives on a volume at /data", () => {
  // caldav-mcp keeps OAuth grants in /data/oauth.kv; without a volume every redeploy signs
  // connectors out.
  assertEquals(service.volumes, [`\${VOLUMES_PATH}/caldav-mcp:/data:z`])
})
