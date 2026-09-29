// Guards every `stacks/<name>/+meta.ts` against its own stack files: the schema is valid,
// every variable compose reads is declared (or server-level), every declared key is read by
// some stack file, and each string default equals the fallback compose already uses, so a
// fresh `stack add` keeps today's behaviour. Stack-specific checks live in
// `stacks/<name>/+meta.test.ts`.

import { assert, assertEquals } from "@std/assert"
import { validateStackMeta } from "../cli/stack-meta.ts"
import { isServerKey } from "../cli/server-keys.ts"
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
  for (const m of text.matchAll(/\$\{([A-Z0-9_]+)(:?-([^}]*))?[:?}]/g)) {
    refs.set(m[1], m[3])
  }
  return refs
}

/** All text files of a stack except tests and +meta.ts, joined. The README counts: a
 * systemd stack such as deepseek-harness reads its variables only in the install steps. */
async function otherFilesOf(name: string): Promise<string> {
  const parts: string[] = []
  const walk = async (rel: string) => {
    for await (const e of Deno.readDir(new URL(`./${name}/${rel}`, stacksDir))) {
      const path = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory) await walk(path)
      else if (!/(\.test\.ts|\+meta\.ts)$/.test(e.name)) {
        parts.push(await Deno.readTextFile(new URL(`./${name}/${path}`, stacksDir)))
      }
    }
  }
  await walk("")
  return parts.join("\n")
}

/**
 * Stacks whose +meta.ts predates this test and misses compose variables. Neither ships in the
 * catalog; the cloud batch of https://github.com/spy4x/rostok/issues/283 completes them and
 * removes them from this list.
 */
const INCOMPLETE = new Set(["mirotalk", "stalwart"])

const names = (await stacksWithMeta()).filter((n) => !INCOMPLETE.has(n))

Deno.test("stacks: at least one stack has a +meta.ts", () => {
  assert(names.length > 0, "found no stacks/*/+meta.ts — the glob or the directory moved")
})

for (const name of names) {
  const meta: StackMeta = (await import(`./${name}/+meta.ts`)).default
  const composeRefs = refsOf(await codeOf(name, "compose.yml"))

  Deno.test(`${name} +meta.ts: passes the StackMeta schema`, () => {
    validateStackMeta(meta)
  })

  Deno.test(`${name} +meta.ts: declares every compose variable that is not server-level`, () => {
    const declared = new Set(meta.variables.map((v) => v.key))
    for (const key of composeRefs.keys()) {
      if (isServerKey(key)) continue
      assert(declared.has(key), `compose.yml reads \${${key}} but +meta.ts does not declare it`)
    }
  })

  Deno.test(`${name} +meta.ts: every declared key is read by a stack file`, async () => {
    const others = await otherFilesOf(name)
    for (const v of meta.variables) {
      assert(others.includes(v.key), `+meta.ts declares ${v.key} but no stack file reads it`)
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
