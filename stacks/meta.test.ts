// Guards every `stacks/<name>/+meta.ts` against its own stack files: the schema is valid,
// every variable compose reads is declared (or server-level), every declared key is read by
// some stack file, and each string default equals the fallback compose already uses, so a
// fresh `stack add` keeps today's behaviour. Stack-specific checks live in
// `stacks/<name>/+meta.test.ts`.

import { assert, assertEquals } from "@std/assert"
import { validateStackMeta } from "../cli/stack-meta.ts"
import { SERVER_KEYS } from "../cli/server-keys.ts"
import type { StackMeta } from "../cli/stack-meta.ts"

const stacksDir = new URL("./", import.meta.url)

/** Stack directory names that have a `+meta.ts`. */
async function stacksWithMeta(): Promise<string[]> {
  const names: string[] = []
  for await (const entry of Deno.readDir(stacksDir)) {
    if (!entry.isDirectory) continue
    try {
      await Deno.stat(new URL(`./${entry.name}/+meta.ts`, stacksDir))
      names.push(entry.name)
    } catch {
      // no +meta.ts yet
    }
  }
  return names.sort()
}

/** Text of a stack file with `#` comment lines removed, or "" when it does not exist. */
async function codeOf(name: string, file: string): Promise<string> {
  try {
    const text = await Deno.readTextFile(new URL(`./${name}/${file}`, stacksDir))
    return text.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n")
  } catch {
    return ""
  }
}

/** Every `${KEY}` a text reads, with its `:-default` when it has one. */
function refsOf(text: string): Map<string, string | undefined> {
  const refs = new Map<string, string | undefined>()
  for (const m of text.matchAll(/\$\{([A-Z0-9_]+)(:?-((?:[^{}]|\$\{[^}]*\})*))?[:?}]/g)) {
    refs.set(m[1], m[3])
  }
  return refs
}

/** Text files of a stack except tests and +meta.ts, by path relative to the stack. */
async function otherFilesOf(name: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  const walk = async (rel: string) => {
    for await (const e of Deno.readDir(new URL(`./${name}/${rel}`, stacksDir))) {
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory) await walk(path)
      else if (!/(\.test\.ts|\+meta\.ts)$/.test(e.name)) {
        files.set(path, await Deno.readTextFile(new URL(`./${name}/${path}`, stacksDir)))
      }
    }
  }
  await walk("")
  return files
}

/**
 * Whether any stack file really uses `key`, not merely names it: a `${KEY` or `$KEY` expansion
 * on a line that is not a comment, or the whole word in a `.ts` file (deploy hooks read
 * `env.KEY`). The README counts for expansions only, because a systemd stack such as
 * deepseek-harness uses its variables in the install steps; its variables table does not.
 */
function isRead(key: string, files: Map<string, string>): boolean {
  const expansion = new RegExp(`\\$\\{?${key}(?![A-Z0-9_])`)
  const word = new RegExp(`(?<![A-Za-z0-9_])${key}(?![A-Za-z0-9_])`)
  for (const [path, text] of files) {
    const code = text.split("\n").filter((l) => !/^\s*(#|\/\/)/.test(l)).join("\n")
    if (expansion.test(code)) return true
    if (path.endsWith(".ts") && word.test(code)) return true
  }
  return false
}

/**
 * Stacks whose +meta.ts predates this test and misses compose variables, so they skip only the
 * "declares every compose variable" check. It does not ship in the catalog; the cloud batch of
 * https://github.com/spy4x/rostok/issues/283 completes it and removes it from this list.
 */
const MISSING_COMPOSE_VARS = new Set(["mirotalk"])

const names = await stacksWithMeta()

/**
 * Keys `server create` writes. Unlike `isServerKey`, this leaves out the other `PATH_*` keys:
 * library folders such as PATH_BOOKS are shared between stacks but nothing writes them on a fresh
 * server, so a stack that mounts one must declare it.
 */
const WRITTEN_BY_SERVER = new Set<string>(SERVER_KEYS)

Deno.test("stacks: at least one stack has a +meta.ts", () => {
  assert(names.length > 0, "found no stacks/*/+meta.ts — the glob or the directory moved")
})

for (const name of names) {
  const meta: StackMeta = (await import(`./${name}/+meta.ts`)).default
  const composeRefs = refsOf(await codeOf(name, "compose.yml"))

  Deno.test(`${name} +meta.ts: passes the StackMeta schema`, () => {
    validateStackMeta(meta)
  })

  Deno.test({
    name: `${name} +meta.ts: declares every compose variable that is not server-level`,
    ignore: MISSING_COMPOSE_VARS.has(name),
  }, () => {
    const declared = new Set(meta.variables.map((v) => v.key))
    for (const key of composeRefs.keys()) {
      if (WRITTEN_BY_SERVER.has(key)) continue
      assert(declared.has(key), `compose.yml reads \${${key}} but +meta.ts does not declare it`)
    }
  })

  Deno.test(`${name} +meta.ts: every declared key is read by a stack file`, async () => {
    const files = await otherFilesOf(name)
    for (const v of meta.variables) {
      assert(isRead(v.key, files), `+meta.ts declares ${v.key} but no stack file reads it`)
    }
  })

  Deno.test(`${name} +meta.ts: string defaults equal compose's own fallbacks`, () => {
    for (const v of meta.variables) {
      const fallback = composeRefs.get(v.key)
      if (fallback === undefined || typeof v.default !== "string") continue
      assertEquals(v.default, fallback, v.key)
    }
  })
}
