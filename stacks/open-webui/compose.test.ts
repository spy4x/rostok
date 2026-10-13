// Guards compose.yml: the tool-server credentials (spy4x/rostok#347), and that default answers
// name no model and turn on no integration with a stack the user may not have added
// (spy4x/rostok#299).

import { assertEquals } from "@std/assert"
import { parse } from "yaml"
import { renderCompose } from "../compose-interpolate.ts"

interface Compose {
  services: Record<string, { environment?: string[]; command?: string[] }>
}

interface ToolServerConnection {
  url: string
  auth_type: string
  key?: string
  config: { enable: boolean }
}

/** What `stack add` always writes: compose refuses to render without the mcpo key. */
const DEFAULT_ANSWERS = { OPEN_WEBUI_MCPO_API_KEY: "generated" }

/** The open-webui container's environment when the server's `.env` holds `env`. */
async function environmentWith(env: Record<string, string>): Promise<Record<string, string>> {
  const rendered = parse(await renderCompose("open-webui", env)) as Compose
  return Object.fromEntries(
    (rendered.services["open-webui"].environment ?? []).map((line) => {
      const at = line.indexOf("=")
      return [line.slice(0, at), line.slice(at + 1)]
    }),
  )
}

/** URLs of the tool servers Open WebUI will contact: the entries with `config.enable` true. */
async function enabledToolServers(env: Record<string, string>): Promise<string[]> {
  const connections = JSON.parse(
    (await environmentWith(env)).TOOL_SERVER_CONNECTIONS,
  ) as ToolServerConnection[]
  return connections.filter((c) => c.config.enable).map((c) => c.url)
}

const MCPO_TOOL_SERVERS = ["http://mcpo:8000/youtube-transcript", "http://mcpo:8000/fetch"]

const compose = parse(
  await Deno.readTextFile(new URL(`./compose.yml`, import.meta.url)),
) as Compose

Deno.test("mcpo: compose requires OPEN_WEBUI_MCPO_API_KEY instead of running unauthenticated", () => {
  const command = compose.services.mcpo.command ?? []
  const keys = command.flatMap((arg, i) => arg === `--api-key` ? [command[i + 1]] : [])
  assertEquals(keys, [`\${OPEN_WEBUI_MCPO_API_KEY:?}`])
})

Deno.test("open-webui: sends mcpo and caldav-mcp each their own bearer key, none hardcoded", async () => {
  const env = await environmentWith({
    OPEN_WEBUI_MCPO_API_KEY: "mcpo-key",
    OPEN_WEBUI_CALDAV_MCP_TOKEN: "caldav-token",
  })
  const connections = JSON.parse(env.TOOL_SERVER_CONNECTIONS) as ToolServerConnection[]
  const bearerKeys = Object.fromEntries(
    connections.filter((c) => c.auth_type === "bearer").map((c) => [c.url, c.key]),
  )
  assertEquals(bearerKeys, {
    "http://mcpo:8000/youtube-transcript": "mcpo-key",
    "http://mcpo:8000/fetch": "mcpo-key",
    "http://hl-caldav-mcp:3000/mcp": "caldav-token",
  })
})

Deno.test("open-webui: with default answers no model is named and every sibling-stack integration is off", async () => {
  const env = await environmentWith(DEFAULT_ANSWERS)
  assertEquals(
    {
      OPENAI_API_CONFIGS: env.OPENAI_API_CONFIGS,
      DEFAULT_MODELS: env.DEFAULT_MODELS,
      ENABLE_IMAGE_GENERATION: env.ENABLE_IMAGE_GENERATION,
      IMAGE_GENERATION_MODEL: env.IMAGE_GENERATION_MODEL,
      CONTENT_EXTRACTION_ENGINE: env.CONTENT_EXTRACTION_ENGINE,
      TIKA_SERVER_URL: env.TIKA_SERVER_URL,
      WEB_LOADER_ENGINE: env.WEB_LOADER_ENGINE,
      PLAYWRIGHT_WS_URL: env.PLAYWRIGHT_WS_URL,
      ENABLE_WEB_SEARCH: env.ENABLE_WEB_SEARCH,
      ENABLE_OLLAMA_API: env.ENABLE_OLLAMA_API,
    },
    {
      OPENAI_API_CONFIGS: "",
      DEFAULT_MODELS: "",
      ENABLE_IMAGE_GENERATION: "false",
      IMAGE_GENERATION_MODEL: "",
      CONTENT_EXTRACTION_ENGINE: "",
      TIKA_SERVER_URL: "",
      WEB_LOADER_ENGINE: "",
      PLAYWRIGHT_WS_URL: "",
      ENABLE_WEB_SEARCH: "false",
      ENABLE_OLLAMA_API: "false",
    },
  )
})

Deno.test("open-webui: with default answers only the stack's own mcpo tool servers are enabled", async () => {
  assertEquals(await enabledToolServers(DEFAULT_ANSWERS), MCPO_TOOL_SERVERS)
})

Deno.test("open-webui: each OPEN_WEBUI_ENABLE_<NAME>_MCP variable enables that stack's tool server and no other", async () => {
  const servers = {
    OPEN_WEBUI_ENABLE_PLAYWRIGHT_MCP: "http://hl-playwright-mcp:8099",
    OPEN_WEBUI_ENABLE_CALDAV_MCP: "http://hl-caldav-mcp:3000/mcp",
    OPEN_WEBUI_ENABLE_EMAIL_MCP: "http://hl-email-mcp:9557/mcp",
    OPEN_WEBUI_ENABLE_GOOGLE_MAPS_MCP: "http://hl-google-maps-mcp:3000/mcp",
    OPEN_WEBUI_ENABLE_GITHUB_MCP: "http://hl-github-mcp:3000/mcp",
  }
  for (const [key, url] of Object.entries(servers)) {
    const enabled = await enabledToolServers({ ...DEFAULT_ANSWERS, [key]: "true" })
    assertEquals(enabled.toSorted(), [...MCPO_TOOL_SERVERS, url].toSorted(), key)
  }
})

Deno.test("open-webui: no shipped file names a model the stack used to hardcode", async () => {
  const dir = new URL("./", import.meta.url)
  const named: string[] = []
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || entry.name.endsWith(".test.ts")) continue
    const text = await Deno.readTextFile(new URL(entry.name, dir))
    for (const m of text.matchAll(/minimax|gemma4|gpt-5\.4|gpt-image/gi)) {
      named.push(`${entry.name}: ${m[0]}`)
    }
  }
  assertEquals(named, [])
})
