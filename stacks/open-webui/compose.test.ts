// Guards the tool-server credentials in compose.yml (spy4x/rostok#347).

import { assertEquals } from "@std/assert"
import { parse } from "yaml"

interface Compose {
  services: Record<string, { environment?: string[]; command?: string[] }>
}

interface ToolServerConnection {
  url: string
  auth_type: string
  key?: string
}

const compose = parse(
  await Deno.readTextFile(new URL(`./compose.yml`, import.meta.url)),
) as Compose

Deno.test("mcpo: compose requires OPEN_WEBUI_MCPO_API_KEY instead of running unauthenticated", () => {
  const command = compose.services.mcpo.command ?? []
  const keys = command.flatMap((arg, i) => arg === `--api-key` ? [command[i + 1]] : [])
  assertEquals(keys, [`\${OPEN_WEBUI_MCPO_API_KEY:?}`])
})

Deno.test("open-webui: sends mcpo and caldav-mcp each their own bearer key, none hardcoded", () => {
  const prefix = `TOOL_SERVER_CONNECTIONS=`
  const entry = (compose.services[`open-webui`].environment ?? [])
    .find((line) => line.startsWith(prefix))
  const connections = JSON.parse(entry?.slice(prefix.length) ?? `[]`) as ToolServerConnection[]
  const bearerKeys = Object.fromEntries(
    connections.filter((c) => c.auth_type === `bearer`).map((c) => [c.url, c.key]),
  )
  assertEquals(bearerKeys, {
    "http://mcpo:8000/youtube-transcript": `\${OPEN_WEBUI_MCPO_API_KEY}`,
    "http://mcpo:8000/fetch": `\${OPEN_WEBUI_MCPO_API_KEY}`,
    "http://hl-caldav-mcp:3000/mcp": `\${OPEN_WEBUI_CALDAV_MCP_TOKEN:-}`,
  })
})
