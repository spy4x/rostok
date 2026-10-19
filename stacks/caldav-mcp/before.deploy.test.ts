import { assertStringIncludes, assertThrows } from "@std/assert"
import { checkPublicRoute } from "./before.deploy.ts"

/** An env reader over a plain object, like `Deno.env.get` over the hook's filtered .env. */
const envOf = (env: Record<string, string>) => (key: string) => env[key]

Deno.test("caldav-mcp hook: a public route with a blank trusted proxy stops the deploy, naming the key and the README section", () => {
  for (const proxies of [undefined, ``, `  `]) {
    const env: Record<string, string> = { CALDAV_MCP_PUBLIC: `true` }
    if (proxies !== undefined) env.CALDAV_MCP_TRUSTED_PROXIES = proxies
    const err = assertThrows(() => checkPublicRoute(envOf(env)), Error)
    assertStringIncludes(err.message, `CALDAV_MCP_TRUSTED_PROXIES`)
    assertStringIncludes(err.message, `"Public with OAuth"`)
  }
})

Deno.test("caldav-mcp hook: every value Traefik reads as true counts as a public route", () => {
  for (const value of [`1`, `t`, `T`, `TRUE`, `True`]) {
    assertThrows(
      () => checkPublicRoute(envOf({ CALDAV_MCP_PUBLIC: value })),
      Error,
      `CALDAV_MCP_TRUSTED_PROXIES`,
      `CALDAV_MCP_PUBLIC=${value}`,
    )
  }
})

Deno.test("caldav-mcp hook: a public route with a trusted proxy deploys", () => {
  checkPublicRoute(
    envOf({ CALDAV_MCP_PUBLIC: `true`, CALDAV_MCP_TRUSTED_PROXIES: `192.0.2.10/32` }),
  )
})

Deno.test("caldav-mcp hook: with the route off a blank trusted proxy still deploys", () => {
  for (const publicRoute of [undefined, `false`, ``]) {
    checkPublicRoute(envOf(publicRoute === undefined ? {} : { CALDAV_MCP_PUBLIC: publicRoute }))
  }
})
