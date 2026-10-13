// Guards what the MCP proxy's browser runs as (spy4x/rostok#338).

import { assertEquals } from "@std/assert"

const dockerfile = Deno.readTextFileSync(new URL(`./Dockerfile.mcp-proxy`, import.meta.url))

Deno.test("playwright-mcp: the image ends as pwuser, not root", () => {
  const users = dockerfile.split(`\n`).filter((line) => line.startsWith(`USER `))
  assertEquals(users.at(-1), `USER pwuser`)
})
