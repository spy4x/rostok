// Tests for the pure helpers of stacks/playwright/after.deploy.ts (spy4x/rostok#338).
// The script's effect on Docker is not run here; the pull request body says how it was run.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import { parse } from "yaml"
import { buildConnectScript, buildSshArgs } from "./after.deploy.ts"

Deno.test("buildConnectScript: skips a server without the client, then connects it to the network", () => {
  const lines = buildConnectScript(`hl-playwright-mcp`, `hl-open-webui`).split(`\n`)
  assertEquals(lines.length, 3)
  assertStringIncludes(lines[0], `docker inspect hl-open-webui >/dev/null 2>&1 || {`)
  assertStringIncludes(lines[0], `exit 0; }`)
  assertStringIncludes(lines[1], `grep -qx hl-playwright-mcp; then`)
  assertStringIncludes(lines[2], `docker network connect hl-playwright-mcp hl-open-webui &&`)
})

Deno.test("buildConnectScript: refuses a name that could carry shell syntax", () => {
  assertThrows(
    () => buildConnectScript(`net; rm -rf /`, `hl-open-webui`),
    Error,
    `invalid Docker name`,
  )
  assertThrows(() => buildConnectScript(`hl-playwright-mcp`, `$(id)`), Error, `invalid Docker name`)
})

Deno.test("buildSshArgs: -p only with a port, the options, '--', the target, then the script as one argument", () => {
  assertEquals(buildSshArgs(`192.0.2.10`, `2222`, `user`, `echo hi`), [
    `-p`,
    `2222`,
    `-o`,
    `ConnectTimeout=10`,
    `-o`,
    `BatchMode=yes`,
    `--`,
    `user@192.0.2.10`,
    `echo hi`,
  ])
  assertEquals(buildSshArgs(`homelab`, undefined, undefined, `echo hi`), [
    `-o`,
    `ConnectTimeout=10`,
    `-o`,
    `BatchMode=yes`,
    `--`,
    `homelab`,
    `echo hi`,
  ])
})

Deno.test("buildSshArgs: rejects a port that is not a port number", () => {
  assertThrows(
    () => buildSshArgs(`homelab`, `22;id`, undefined, `echo hi`),
    Error,
    `invalid SSH_PORT`,
  )
  assertThrows(
    () => buildSshArgs(`homelab`, `70000`, undefined, `echo hi`),
    Error,
    `invalid SSH_PORT`,
  )
})

Deno.test("after.deploy.ts: connects Open WebUI to the network compose.yml creates", async () => {
  const compose = parse(await Deno.readTextFile(new URL(`./compose.yml`, import.meta.url))) as {
    networks: Record<string, { name?: string }>
  }
  const source = await Deno.readTextFile(new URL(`./after.deploy.ts`, import.meta.url))
  assertStringIncludes(source, `const NETWORK = \`${compose.networks.mcp.name}\``)
  assertStringIncludes(source, "const CLIENT = `hl-open-webui`")
})
