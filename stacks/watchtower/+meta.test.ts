// Guards that stacks/watchtower/+meta.ts stays in step with its compose.yml:
// the schema is valid, every compose variable without a default is
// declared (or server-level), and each declared default equals the
// default compose falls back to, so a fresh `stack add` keeps today's behaviour.

import { assert, assertEquals } from "@std/assert"
import { validateStackMeta } from "../../cli/stack-meta.ts"
import { isServerKey } from "../../cli/server-keys.ts"
import meta from "./+meta.ts"

const compose = await Deno.readTextFile(new URL("./compose.yml", import.meta.url))
const composeCode = compose.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n")

/** Every `${KEY}` compose reads, with its `:-default` when it has one. */
function composeRefs(): Map<string, string | undefined> {
  const refs = new Map<string, string | undefined>()
  for (const m of composeCode.matchAll(/\$\{([A-Z0-9_]+)(:?-([^}]*))?[:?}]/g)) {
    refs.set(m[1], m[3])
  }
  return refs
}

Deno.test("watchtower +meta.ts: passes the StackMeta schema", () => {
  validateStackMeta(meta)
})

Deno.test("watchtower +meta.ts: declares every compose variable that is not server-level", () => {
  const declared = new Set(meta.variables.map((v) => v.key))
  for (const key of composeRefs().keys()) {
    if (isServerKey(key)) continue
    assert(declared.has(key), `compose.yml reads \${${key}} but +meta.ts does not declare it`)
  }
})

Deno.test("watchtower +meta.ts: every declared key is read by compose.yml", () => {
  const refs = composeRefs()
  for (const v of meta.variables) {
    assert(refs.has(v.key), `+meta.ts declares ${v.key} but compose.yml never reads it`)
  }
})

Deno.test("watchtower +meta.ts: string defaults equal compose's own fallbacks", () => {
  const refs = composeRefs()
  for (const v of meta.variables) {
    const fallback = refs.get(v.key)
    if (fallback === undefined || typeof v.default !== "string") continue
    assertEquals(v.default, fallback, v.key)
  }
})
