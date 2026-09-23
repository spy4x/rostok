// Catalog consistency test.
//
// The catalog's `+meta.ts` files must agree with their `compose.yml` and
// hooks — see #205 and #210. Checks, per catalog stack:
//
//   1. Every `${VAR}` in compose.yml without a `:-`/`-` bash default is
//      either declared in that stack's +meta.ts or is a server-level key
//      (isServerKey()).
//   2. Every +meta.ts key is referenced by something else in the stack
//      directory (compose.yml, a hook, the README, …) — dead schema.
//   3. A +meta.ts key that isn't a server key carries the stack's own
//      prefix (stackKeyPrefix()), and no two stacks declare the same
//      non-server key.
//   4. Every `Host(...)` rule in compose.yml reads exactly the stack's
//      `${<PREFIX>DOMAIN}` — no `${X_SUBDOMAIN}`, no hardcoded host.
//   5. `before.deploy.ts` / `after.deploy.ts` import nothing via a
//      relative path that leaves the stack directory (the deploy hook
//      contract — these run from an installed package's https:// URL).
//
// deepseek-harness ships no compose.yml (host-level install, see its
// README) — checks 1 and 4 skip a stack with no compose.yml; checks 2
// and 3 still run.
//
// `checkStack()` takes a directory and a name so the same logic can run
// against a stale copy of `stacks/` (see the PR's Evidence section,
// "prove it fails on main") without touching this file.

import { assertEquals } from "@std/assert"
import { fromFileUrl } from "@std/path"
import { loadCatalog } from "./catalog.ts"
import { isServerKey, stackKeyPrefix } from "./server-keys.ts"
import type { StackMeta } from "./stack-meta.ts"

export type Violation = string

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null
    throw err
  }
}

/**
 * Blank out full-line YAML comments. Compose interpolates `${VAR}`
 * inside parsed scalar values only — a reference inside a commented-out
 * line never reaches it, so the check must ignore it too.
 */
export function stripFullLineComments(yamlText: string): string {
  return yamlText
    .split("\n")
    .map((line) => (line.trim().startsWith("#") ? "" : line))
    .join("\n")
}

interface VarRef {
  key: string
  hasDefault: boolean
}

/** Every `${VAR}`, `${VAR:-default}` and `${VAR-default}` reference in compose text. */
export function findComposeRefs(composeText: string): VarRef[] {
  const refs: VarRef[] = []
  const re = /\$\{([A-Z_][A-Z0-9_]*)(:?-[^}]*)?\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(composeText)) !== null) {
    refs.push({ key: m[1], hasDefault: m[2] !== undefined })
  }
  return refs
}

/** Every `Host(...)` rule's raw contents (e.g. `` `${GATUS_DOMAIN}` ``). */
export function findHostRules(composeText: string): string[] {
  const rules: string[] = []
  const re = /Host\(([^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(composeText)) !== null) {
    rules.push(m[1].trim())
  }
  return rules
}

/** `from "../..."` or `import("../...")` specifiers that climb out of the current directory. */
export function findEscapingImports(hookText: string): string[] {
  const specifiers: string[] = []
  const re = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(hookText)) !== null) {
    if (m[1].startsWith("../")) specifiers.push(m[1])
  }
  return specifiers
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory) {
      yield* walkFiles(path)
    } else if (entry.isFile) {
      yield path
    }
  }
}

/** True when `key` appears as a whole word anywhere else in the stack directory. */
async function keyIsReadSomewhere(dir: string, key: string): Promise<boolean> {
  const re = new RegExp(`\\b${key}\\b`)
  for await (const path of walkFiles(dir)) {
    if (path.endsWith("/+meta.ts")) continue
    const text = await readIfExists(path)
    if (text && re.test(text)) return true
  }
  return false
}

/**
 * Run every catalog-consistency check against one stack directory.
 * `seenKeys` is shared across stacks (by the caller) to catch two stacks
 * declaring the same non-server key.
 */
export async function checkStack(
  dir: string,
  name: string,
  meta: StackMeta,
  seenKeys: Map<string, string>,
): Promise<Violation[]> {
  const violations: Violation[] = []
  const prefix = stackKeyPrefix(name)
  const metaKeys = meta.variables.map((v) => v.key)
  const metaKeySet = new Set(metaKeys)

  const composeTextRaw = await readIfExists(`${dir}/compose.yml`)
  const composeText = composeTextRaw ? stripFullLineComments(composeTextRaw) : null

  // 1. compose ${VAR} without a default must be declared or server-level.
  if (composeText) {
    for (const ref of findComposeRefs(composeText)) {
      if (ref.hasDefault) continue
      if (isServerKey(ref.key)) continue
      if (metaKeySet.has(ref.key)) continue
      violations.push(
        `compose.yml reads \${${ref.key}} with no default; not in +meta.ts and not a server key`,
      )
    }
  }

  // 2. every +meta.ts key must be read by something else in the stack.
  for (const key of metaKeys) {
    if (!(await keyIsReadSomewhere(dir, key))) {
      violations.push(`+meta.ts declares "${key}" but nothing else in the stack reads it`)
    }
  }

  // 3. prefix + cross-stack uniqueness (server keys exempt from both).
  for (const key of metaKeys) {
    if (isServerKey(key)) continue
    if (!key.startsWith(prefix)) {
      violations.push(
        `"${key}" is not a server key and doesn't carry the stack prefix "${prefix}"`,
      )
      continue
    }
    const owner = seenKeys.get(key)
    if (owner && owner !== name) {
      violations.push(`"${key}" is also declared by stack "${owner}"`)
    } else {
      seenKeys.set(key, name)
    }
  }

  // 4. Host() rules use exactly the stack's own <PREFIX>DOMAIN.
  if (composeText) {
    const expected = "`${" + prefix + "DOMAIN}`"
    for (const rule of findHostRules(composeText)) {
      if (rule !== expected) {
        violations.push(`Host(${rule}) does not read \${${prefix}DOMAIN}`)
      }
    }
  }

  // 5. hooks import nothing that leaves the stack directory.
  for (const hookName of ["before.deploy.ts", "after.deploy.ts"]) {
    const hookText = await readIfExists(`${dir}/${hookName}`)
    if (!hookText) continue
    for (const spec of findEscapingImports(hookText)) {
      violations.push(`${hookName} imports "${spec}", which leaves the stack directory`)
    }
  }

  return violations
}

Deno.test("catalog: every stack's +meta.ts agrees with its compose.yml and hooks", async () => {
  const catalog = loadCatalog()
  const seenKeys = new Map<string, string>()
  const allViolations: string[] = []

  for (const entry of catalog) {
    // Resolve relative to this test file, never the current directory —
    // `deno test` may run from any cwd.
    const dir = fromFileUrl(new URL(`../stacks/${entry.name}`, import.meta.url))
    const violations = await checkStack(dir, entry.name, entry.meta, seenKeys)
    for (const v of violations) {
      allViolations.push(`${entry.name}: ${v}`)
    }
  }

  assertEquals(allViolations, [], allViolations.join("\n"))
})

// ── Unit tests for the parsing helpers ─────────────────────────────────

Deno.test("stripFullLineComments: blanks a commented-out line, keeps others", () => {
  const text = [
    "services:",
    "  x:",
    "      # - ADMIN_TOKEN=${VAULTWARDEN_ADMIN_TOKEN}",
    '      - "${DOCKER_GROUP_ID:-990}" # inline comment stays',
  ].join("\n")
  const stripped = stripFullLineComments(text)
  assertEquals(stripped.includes("ADMIN_TOKEN"), false)
  assertEquals(stripped.includes("DOCKER_GROUP_ID:-990"), true)
})

Deno.test("findComposeRefs: distinguishes refs with and without a bash default", () => {
  const refs = findComposeRefs("a: ${FOO} b: ${BAR:-1} c: ${BAZ-2}")
  assertEquals(refs, [
    { key: "FOO", hasDefault: false },
    { key: "BAR", hasDefault: true },
    { key: "BAZ", hasDefault: true },
  ])
})

Deno.test("findHostRules: extracts the raw rule contents", () => {
  const rules = findHostRules(
    '- "traefik.http.routers.hl-gatus.rule=Host(`${GATUS_DOMAIN}`)"',
  )
  assertEquals(rules, ["`${GATUS_DOMAIN}`"])
})

Deno.test("findEscapingImports: flags a parent-directory import, not a same-dir one", () => {
  const specs = findEscapingImports(
    `import { restartRemoteContainer } from "../../scripts/+lib.ts"\n` +
      `import { helper } from "./helper.ts"\n` +
      `import bcrypt from "npm:bcryptjs@3.0.3"\n`,
  )
  assertEquals(specs, ["../../scripts/+lib.ts"])
})

Deno.test("checkStack: flags an undeclared, default-less compose var", async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(
      `${dir}/compose.yml`,
      "services:\n  x:\n    environment:\n      - FOO=${ACME_UNDECLARED}\n",
    )
    const meta: StackMeta = { name: "acme", description: "test", variables: [] }
    const violations = await checkStack(dir, "acme", meta, new Map())
    assertEquals(
      violations.some((v) => v.includes("ACME_UNDECLARED")),
      true,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("checkStack: flags a +meta.ts key nothing in the stack reads", async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(`${dir}/compose.yml`, "services:\n  x:\n    image: acme\n")
    const meta: StackMeta = {
      name: "acme",
      description: "test",
      variables: [{ key: "ACME_UNUSED", required: false, default: "x" }],
    }
    const violations = await checkStack(dir, "acme", meta, new Map())
    assertEquals(
      violations.some((v) => v.includes("ACME_UNUSED") && v.includes("nothing else")),
      true,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("checkStack: flags a non-server key missing its stack prefix", async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(`${dir}/compose.yml`, "services:\n  x:\n    image: ${WRONG_PREFIX}\n")
    const meta: StackMeta = {
      name: "acme",
      description: "test",
      variables: [{ key: "WRONG_PREFIX", required: false, default: "x" }],
    }
    const violations = await checkStack(dir, "acme", meta, new Map())
    assertEquals(
      violations.some((v) => v.includes("WRONG_PREFIX") && v.includes("prefix")),
      true,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("checkStack: flags two stacks declaring the same non-server key", async () => {
  // Two distinct stack names that hash to the same prefix (stackKeyPrefix
  // uppercases) — the realistic trigger is a copy-pasted variable block
  // that keeps the source stack's key, which normally also fails the
  // prefix check; this isolates the uniqueness check on its own.
  const dirA = await Deno.makeTempDir()
  const dirB = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(`${dirA}/compose.yml`, "x: ${ACME_SHARED}\n")
    await Deno.writeTextFile(`${dirB}/compose.yml`, "x: ${ACME_SHARED}\n")
    const meta: StackMeta = {
      name: "acme",
      description: "test",
      variables: [{ key: "ACME_SHARED", required: false, default: "x" }],
    }
    const seenKeys = new Map<string, string>()
    const violationsA = await checkStack(dirA, "acme", meta, seenKeys)
    const violationsB = await checkStack(dirB, "ACME", meta, seenKeys)
    assertEquals(violationsA.some((v) => v.includes("ACME_SHARED")), false)
    assertEquals(
      violationsB.some((v) => v.includes("ACME_SHARED") && v.includes("also declared")),
      true,
    )
  } finally {
    await Deno.remove(dirA, { recursive: true })
    await Deno.remove(dirB, { recursive: true })
  }
})

Deno.test("checkStack: flags a Host() rule that doesn't use <PREFIX>_DOMAIN", async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(
      `${dir}/compose.yml`,
      "labels:\n" +
        '  - "traefik.http.routers.x.rule=Host(`${ACME_SUBDOMAIN}.${DOMAIN}`)"\n',
    )
    const meta: StackMeta = {
      name: "acme",
      description: "test",
      variables: [{ key: "ACME_SUBDOMAIN", required: false, default: "x" }],
    }
    const violations = await checkStack(dir, "acme", meta, new Map())
    assertEquals(
      violations.some((v) => v.includes("Host(") && v.includes("ACME_DOMAIN")),
      true,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("checkStack: flags a hook that imports out of its stack directory", async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(
      `${dir}/after.deploy.ts`,
      'import { restartRemoteContainer } from "../../scripts/+lib.ts"\n' +
        'await restartRemoteContainer("hl-acme")\n',
    )
    const meta: StackMeta = { name: "acme", description: "test", variables: [] }
    const violations = await checkStack(dir, "acme", meta, new Map())
    assertEquals(
      violations.some((v) => v.includes("after.deploy.ts") && v.includes("../../scripts")),
      true,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
