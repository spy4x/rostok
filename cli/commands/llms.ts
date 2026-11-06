// `rostok llms` — write `llms.txt`, the map of a project's services for AI agents.
//
// For every stack in every `servers/<server>/config.json` it lists the server, the stack's
// URLs, its catalog description and the owner's `aiNotes`, grouped by `aiCanUse`. The URLs
// come from the stack's own `*_DOMAIN` keys in the plaintext `.env.root` and server `.env`
// (server wins, as in compose). No other value of those files is read into the output: only
// `*_DOMAIN` keys and the `SERVER_NAME`/`DOMAIN` they may refer to.
//
//   rostok llms           # write llms.txt
//   rostok llms --check   # fail when llms.txt is out of date; writes nothing

import { Command } from "@cliffy/command"
import { join } from "@std/path"
import { type CatalogEntry, loadCatalog } from "../catalog.ts"
import { resolveReferences, type ServerContext } from "../defaults.ts"
import { decodeEnvValue, readEnvFile } from "../env-files.ts"
import { UserError } from "../errors.ts"
import { stackKeyPrefix } from "../server-keys.ts"
import type { StackConfig } from "../deploy/deploy-script.ts"
import { validateStackConfigs } from "../deploy/validate-stack-config.ts"

/** The file `rostok llms` writes, relative to the project root. */
export const LLMS_FILE = "llms.txt"

/** One stack on one server, as `llms.txt` lists it. */
export interface LlmsService {
  stack: string
  server: string
  urls: string[]
  description: string
  aiCanUse?: boolean
  aiNotes?: string
}

/** Collapse whitespace, so a value from config.json or `.env` stays on its own line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/** Server folder names under `servers/` that hold a `config.json`, sorted. */
async function serverNames(cwd: string): Promise<string[]> {
  const names: string[] = []
  try {
    for await (const entry of Deno.readDir(join(cwd, "servers"))) {
      if (!entry.isDirectory) continue
      try {
        await Deno.stat(join(cwd, "servers", entry.name, "config.json"))
        names.push(entry.name)
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err
      }
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new UserError(
        `no servers/ folder in ${cwd}: run \`rostok llms\` from the project root.`,
      )
    }
    throw err
  }
  return names.sort()
}

/**
 * Read every stack of every server, sorted by server, then stack. Fails when a server's
 * `.env` is missing, since its URLs live there. `catalog` supplies the descriptions.
 */
export async function collectServices(
  cwd: string,
  catalog: CatalogEntry[] = loadCatalog(),
): Promise<LlmsService[]> {
  const rootEnv = await readEnvFile(join(cwd, ".env.root"))
  const services: LlmsService[] = []
  for (const server of await serverNames(cwd)) {
    const serverDir = join(cwd, "servers", server)
    const configPath = join(serverDir, "config.json")
    const stacks: StackConfig[] = JSON.parse(await Deno.readTextFile(configPath)).stacks ?? []
    validateStackConfigs(stacks, configPath)
    const envPath = join(serverDir, ".env")
    const serverEnv = await readEnvFile(envPath)
    if (serverEnv.length === 0) {
      throw new UserError(`${envPath} is missing or empty: run \`rostok env decrypt\` first.`)
    }
    // Server values win over .env.root, the way compose reads the two files.
    const env = new Map<string, string>()
    for (const { key, value } of [...rootEnv, ...serverEnv]) {
      if (key === "SERVER_NAME" || key === "DOMAIN" || key.endsWith("_DOMAIN")) {
        env.set(key, decodeEnvValue(value))
      }
    }
    const ctx = {
      SERVER_NAME: env.get("SERVER_NAME") ?? server,
      DOMAIN: env.get("DOMAIN") ?? "",
    } as ServerContext
    for (const stack of stacks) {
      const prefix = stackKeyPrefix(stack.name)
      const urls = [...env.keys()]
        .filter((key) => key.startsWith(prefix) && key.endsWith("_DOMAIN"))
        .sort()
        .map((key) => `https://${oneLine(resolveReferences(env.get(key) ?? "", ctx))}`)
      const entry = catalog.find((e) => e.name === stack.name || e.meta.name === stack.name)
      services.push({
        stack: stack.name,
        server,
        urls,
        description: oneLine(entry?.meta.description ?? ""),
        aiCanUse: stack.aiCanUse,
        aiNotes: stack.aiNotes === undefined ? undefined : oneLine(stack.aiNotes),
      })
    }
  }
  // Code-unit order, not localeCompare: the same bytes on every machine and locale.
  const key = (s: LlmsService) => `${s.server}\0${s.stack}`
  return services.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
}

function serviceLine(s: LlmsService): string {
  const urls = s.urls.length > 0 ? s.urls.join(", ") : "no URL"
  const parts = [`- **${s.stack}** on server \`${s.server}\`: ${urls}`]
  if (s.description) parts.push(s.description)
  if (s.aiNotes) parts.push(`Notes: ${s.aiNotes}`)
  return parts.join(" — ")
}

/** Render `llms.txt`: a header, then the three sections by `aiCanUse`. Same input, same bytes. */
export function renderLlms(services: LlmsService[]): string {
  const sections: [string, (s: LlmsService) => boolean][] = [
    ["Agents may use", (s) => s.aiCanUse === true],
    ["Ask the owner before using", (s) => s.aiCanUse === undefined],
    ["Agents must not use", (s) => s.aiCanUse === false],
  ]
  const lines = [
    "# Self-hosted services",
    "",
    "> Generated by `rostok llms` from `servers/*/config.json`. Do not edit this file: set",
    "> `aiCanUse` (true or false) and `aiNotes` on a stack in `servers/<server>/config.json`,",
    "> then run `rostok llms` again.",
  ]
  for (const [title, matches] of sections) {
    const list = services.filter(matches).map(serviceLine)
    lines.push("", `## ${title}`, "", ...(list.length > 0 ? list : ["None."]))
  }
  return lines.join("\n") + "\n"
}

/**
 * Write `llms.txt` in `cwd`, or with `check` compare it with what would be written and throw
 * when it differs. Returns the line to print.
 */
export async function runLlms(cwd: string, check: boolean): Promise<string> {
  const services = await collectServices(cwd)
  const text = renderLlms(services)
  const path = join(cwd, LLMS_FILE)
  if (check) {
    let current: string | undefined
    try {
      current = await Deno.readTextFile(path)
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err
    }
    if (current !== text) {
      throw new UserError(`${LLMS_FILE} is out of date: run \`rostok llms\` and commit it.`)
    }
    return `${LLMS_FILE} is up to date.`
  }
  await Deno.writeTextFile(path, text)
  return `Wrote ${LLMS_FILE} (${services.length} ${
    services.length === 1 ? "service" : "services"
  }).`
}

/** `rostok llms` — the subcommand. */
export const llmsCommand = new Command()
  .description(
    `Write llms.txt: which services run where, and whether AI agents may use them.

Reads servers/*/config.json (aiCanUse, aiNotes) and the *_DOMAIN keys of the
plaintext .env files. Run it from the project root after \`rostok env decrypt\`.

Examples:

    rostok llms             # write llms.txt
    rostok llms --check     # fail when llms.txt is out of date; writes nothing`,
  )
  .option("--check", "fail when llms.txt is out of date; write nothing")
  .action(async (options) => {
    console.log(await runLlms(Deno.cwd(), options.check ?? false))
  })
