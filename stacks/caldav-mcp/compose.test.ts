// Guards the bearer token and OAuth wiring in compose.yml (spy4x/rostok#347).

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

const service = compose.services[`caldav-mcp`]

/** The `KEY=value` entries of the service environment whose key is `key`. */
function envEntries(key: string): string[] {
  return service.environment.filter((entry) => entry.startsWith(`${key}=`))
}

Deno.test("caldav-mcp: the bearer token comes only from the server's CALDAV_MCP_TOKEN, blank when unset", () => {
  // Never a fixed value. Blank is safe: caldav-mcp refuses to start in HTTP mode with neither
  // the token nor OAuth, and a public OAuth-only server leaves the token unset.
  assertEquals(envEntries(`MCP_BEARER_TOKEN`), [`MCP_BEARER_TOKEN=\${CALDAV_MCP_TOKEN:-}`])
})

Deno.test("caldav-mcp: with OAuth on the bearer token is refused unless the server opts in", () => {
  // A public server must not take the static token next to OAuth just because one is set.
  assertEquals(envEntries(`ALLOW_BEARER_TOKEN_WITH_OAUTH`), [
    `ALLOW_BEARER_TOKEN_WITH_OAUTH=\${CALDAV_MCP_ALLOW_TOKEN_WITH_OAUTH:-false}`,
  ])
})

Deno.test("caldav-mcp: the image is v1.2.0 or later, which knows ALLOW_BEARER_TOKEN_WITH_OAUTH", () => {
  // Older images ignore the option and accept the static token next to OAuth.
  const dockerfile = Deno.readTextFileSync(new URL(`./Dockerfile`, import.meta.url))
  const [major, minor] = (dockerfile.match(/^ARG CALDAV_MCP_VERSION=v(\d+)\.(\d+)\.\d+$/m) ?? [])
    .slice(1).map(Number)
  assertEquals(major! > 1 || (major === 1 && minor! >= 2), true)
})

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
