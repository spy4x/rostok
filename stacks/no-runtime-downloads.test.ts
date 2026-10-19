// Keeps every catalog container on the code its image holds (spy4x/rostok#410). `npx -y`, `uvx`
// and `uv run` fetch a package, or a build tool, from a registry each time a container starts, so
// a pinned image still runs whatever npm or PyPI serves that day, and the container does not start
// at all when the registry is out of reach. Install the program when the image is built instead,
// as `playwright/Dockerfile.mcp-proxy` and `open-webui/Dockerfile.mcpo` do.
//
// Scanned: every file under `stacks/` except docs (`*.md`), Deno hooks and tests (`*.ts`) and
// lockfiles. YAML and JSON files are parsed, so comments do not count and a command split into an
// array (`["npx", "-y", …]`, or mcpo's `"command"` plus `"args"`) is read as one line. Other files
// are read line by line, without their `#` and `//` comment lines.

import { assert, assertEquals } from "@std/assert"
import { walk } from "@std/fs"
import { extname, fromFileUrl, relative } from "@std/path"
import { parse } from "yaml"

const stacksDir = fromFileUrl(new URL("./", import.meta.url))

/** A command that downloads what it runs: `npx -y`/`npx --yes`, `uvx`, `uv run`. */
const RUNTIME_DOWNLOAD = /(^|[\s"'\[/])(npx\s+(-y|--yes)\b|uvx\b|uv\s+run\b)/

/** Every command-like string in a parsed YAML or JSON value. */
function commandLines(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) {
    const lines = value.flatMap(commandLines)
    if (value.every((item) => typeof item === "string")) lines.push(value.join(" "))
    return lines
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const lines = Object.values(record).flatMap(commandLines)
    // mcpo, Claude Desktop and similar configs: `"command": "npx", "args": ["-y", …]`.
    if (typeof record.command === "string" && Array.isArray(record.args)) {
      lines.push([record.command, ...record.args].join(" "))
    }
    return lines
  }
  return []
}

/** The lines of one file that start a program through a runtime download. */
export function runtimeDownloads(path: string, text: string): string[] {
  const ext = extname(path)
  const lines = ext === ".yml" || ext === ".yaml" || ext === ".json"
    ? commandLines(ext === ".json" ? JSON.parse(text) : parse(text, { logLevel: "error" }))
    : text.split("\n").filter((line) => !/^\s*(#|\/\/)/.test(line))
  const found = lines.filter((line) => RUNTIME_DOWNLOAD.test(line))
  // `"command": "uvx"` matches alone and again joined with its args: report the joined line only.
  return found.filter((line) => !found.some((other) => other !== line && other.includes(line)))
}

Deno.test("no-runtime-downloads: finds npx -y, uvx and uv run in compose, mcpo config and Dockerfiles", () => {
  const compose = `services:\n  a:\n    command: npx -y playwright@1.60.0 run-server\n` +
    `  b:\n    entrypoint: ["tini", "--", "uv", "run", "server"]\n`
  assertEquals(runtimeDownloads("compose.yml", compose).length, 2)
  const mcpo = JSON.stringify({
    mcpServers: {
      a: { command: "npx", args: ["--yes", "some-server"] },
      b: { command: "uvx", args: ["other-server"] },
    },
  })
  assertEquals(runtimeDownloads("mcpo-config.json", mcpo).length, 2)
  assertEquals(runtimeDownloads("Dockerfile", `CMD ["uvx", "tool"]\n`).length, 1)
})

Deno.test("no-runtime-downloads: ignores comments and commands that run what is installed", () => {
  const compose =
    `# mcpo includes npx and uvx\nservices:\n  a:\n    command: playwright run-server\n` +
    `    healthcheck:\n      test: ["CMD", "npx", "--no-install", "playwright", "--version"]\n`
  assertEquals(runtimeDownloads("compose.yml", compose), [])
  const dockerfile = `# uvx would download\nRUN uv pip install tool==1.0 && npm install -g x@1\n`
  assertEquals(runtimeDownloads("Dockerfile", dockerfile), [])
})

Deno.test("no-runtime-downloads: no file under stacks/ starts a program through npx -y, uvx or uv run", async () => {
  const found: string[] = []
  let composeFiles = 0
  for await (const entry of walk(stacksDir, { includeDirs: false })) {
    if (/\.(md|ts|lock)$/.test(entry.name)) continue
    if (entry.name === "compose.yml") composeFiles++
    const path = relative(stacksDir, entry.path)
    for (const line of runtimeDownloads(path, await Deno.readTextFile(entry.path))) {
      found.push(`${path}: ${line.trim()}`)
    }
  }
  // A walk that found nothing would pass silently: the catalog has dozens of compose files.
  assert(composeFiles > 20, `only ${composeFiles} compose files found under ${stacksDir}`)
  assertEquals(found, [])
})
