// Catalog consistency test.
//
// The catalog's `+meta.ts` files must agree with their `compose.yml` and
// hooks — see #205 and #210. Checks, per catalog stack:
//
//   1. Every `${VAR}` in compose.yml without a bash default (`:-`, `-`)
//      is either declared in that stack's +meta.ts or is a server-level
//      key (isServerKey()). `${VAR:?msg}`/`${VAR?msg}` count as "no
//      default" too — they fail rather than substitute anything.
//      `${VAR:+alt}`/`${VAR+alt}` count as having one — they never
//      trigger compose's "variable is not set" warning.
//   2. Every +meta.ts key is read by compose.yml or a hook (not the
//      README or anything else) — dead schema. deepseek-harness is
//      exempt: a host-level install with neither compose.yml nor hooks,
//      whose one key is consumed by hand from its README's install
//      command, which this test doesn't parse.
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
// README) — checks 1 and 4 skip a stack with no compose.yml; check 2
// skips it by name (see above); check 3 still runs.
//
// `checkStack()` takes a directory and a name so the same logic can run
// against a stale copy of `stacks/` (see the PR's Evidence section,
// "prove it fails on main") without touching this file.

import { assertEquals } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
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

/**
 * Every `${VAR<op><rest>}` reference in compose text, for bare `${VAR}`
 * and bash's four two-character parameter-expansion operators:
 * `:-`/`-` (default value), `:?`/`?` (error if unset — no substitute, so
 * this still counts as "no default"), `:+`/`+` (alternate value only
 * when set — never triggers a "variable is not set" warning).
 */
export function findComposeRefs(composeText: string): VarRef[] {
  const refs: VarRef[] = []
  const re = /\$\{([A-Z_][A-Z0-9_]*)(:?[-?+][^}]*)?\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(composeText)) !== null) {
    refs.push({ key: m[1], hasDefault: hasBashFallback(m[2]) })
  }
  return refs
}

/** `-`/`+` supply a fallback (no warning risk); bare `${VAR}` and `?` don't. */
function hasBashFallback(operatorAndRest: string | undefined): boolean {
  if (operatorAndRest === undefined) return false
  const op = operatorAndRest.startsWith(":") ? operatorAndRest[1] : operatorAndRest[0]
  return op === "-" || op === "+"
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

/** Files a +meta.ts key must be read by — compose.yml or a hook, nothing else (not the README). */
const READABLE_FILES = ["compose.yml", "before.deploy.ts", "after.deploy.ts"]

/** True when `key` appears as a whole word in compose.yml or a hook. */
async function keyIsReadSomewhere(dir: string, key: string): Promise<boolean> {
  const re = new RegExp(`\\b${key}\\b`)
  for (const name of READABLE_FILES) {
    const text = await readIfExists(`${dir}/${name}`)
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

  // 2. every +meta.ts key must be read by compose.yml or a hook.
  // deepseek-harness is a host-level install with neither — its one key
  // is consumed by hand from the README's install command, which this
  // test doesn't parse — so it's exempt from this check by name.
  if (name !== "deepseek-harness") {
    for (const key of metaKeys) {
      if (!(await keyIsReadSomewhere(dir, key))) {
        violations.push(`+meta.ts declares "${key}" but nothing in compose.yml or a hook reads it`)
      }
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

Deno.test("findComposeRefs: :?/? (required, errors if unset) count as no default", () => {
  const refs = findComposeRefs("a: ${FOO:?required} b: ${BAR?required}")
  assertEquals(refs, [
    { key: "FOO", hasDefault: false },
    { key: "BAR", hasDefault: false },
  ])
})

Deno.test("findComposeRefs: :+/+ (alternate value) count as having a default", () => {
  const refs = findComposeRefs("a: ${FOO:+alt} b: ${BAR+alt}")
  assertEquals(refs, [
    { key: "FOO", hasDefault: true },
    { key: "BAR", hasDefault: true },
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
      violations.some((v) => v.includes("ACME_UNUSED") && v.includes("nothing in compose.yml")),
      true,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("checkStack: a README-only mention doesn't count as read", async () => {
  // The "read somewhere" check used to scan the whole stack directory,
  // which let a key satisfy it by being mentioned only in prose. It now
  // scans compose.yml and the two hooks only.
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(`${dir}/compose.yml`, "services:\n  x:\n    image: acme\n")
    await Deno.writeTextFile(`${dir}/README.md`, "Set ACME_DOCS_ONLY to configure this.\n")
    const meta: StackMeta = {
      name: "acme",
      description: "test",
      variables: [{ key: "ACME_DOCS_ONLY", required: false, default: "x" }],
    }
    const violations = await checkStack(dir, "acme", meta, new Map())
    assertEquals(
      violations.some((v) => v.includes("ACME_DOCS_ONLY")),
      true,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("checkStack: exempts deepseek-harness (no compose.yml, no hooks) from the read-somewhere check", async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(`${dir}/README.md`, "npm install ... @${DEEPSEEK_HARNESS_VERSION}\n")
    const meta: StackMeta = {
      name: "deepseek-harness",
      description: "test",
      variables: [{ key: "DEEPSEEK_HARNESS_VERSION", required: false, default: "1.0.0" }],
    }
    const violations = await checkStack(dir, "deepseek-harness", meta, new Map())
    assertEquals(violations, [])
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

// ─────────────────────────────────────────────────────────────────────
// Guard test — every dropped legacy env key name (see the PR that
// dropped the fallbacks) must never reappear in a stack's compose.yml
// or deploy hooks. Runs against every directory under stacks/, not just
// the ones with a +meta.ts — most stacks (ntfy, wireguard, gitea, ...)
// don't have one yet.
// ─────────────────────────────────────────────────────────────────────

/** A `${VAR}` reference, with an optional bash default/error/alt suffix stripped. */
const VAR_REF = /\$\{([A-Z][A-Z0-9_]*)(?:[:?+-][^}]*)?\}/g

/**
 * Scan `text` (a compose.yml or a *.deploy.ts) for a reference to a
 * legacy env key name: `HOMELAB_USER`, a `BASIC_AUTH_` key without the
 * `TRAEFIK_`/`GATUS_` prefix, `${X_SUBDOMAIN}`, or an unprefixed
 * `${SMTP_...}`. Returns the offending key for each match found.
 */
export function findLegacyEnvKeyUsages(text: string): string[] {
  const found: string[] = []
  if (/\bHOMELAB_USER\b/.test(text)) found.push("HOMELAB_USER")
  for (const match of text.matchAll(VAR_REF)) {
    const key = match[1]
    if (
      key.includes("BASIC_AUTH_") && !key.startsWith("TRAEFIK_") && !key.startsWith("GATUS_")
    ) {
      found.push(key)
    }
    if (key.endsWith("_SUBDOMAIN")) found.push(key)
    if (key.startsWith("SMTP_")) found.push(key)
  }
  return found
}

Deno.test("findLegacyEnvKeyUsages: flags HOMELAB_USER", () => {
  assertEquals(findLegacyEnvKeyUsages("owner: {{ HOMELAB_USER }}"), ["HOMELAB_USER"])
})

Deno.test("findLegacyEnvKeyUsages: flags a BASIC_AUTH_ key without TRAEFIK_/GATUS_", () => {
  assertEquals(findLegacyEnvKeyUsages("- ${BASIC_AUTH_USER}"), ["BASIC_AUTH_USER"])
})

Deno.test("findLegacyEnvKeyUsages: does not flag TRAEFIK_/GATUS_-prefixed basic auth keys", () => {
  assertEquals(
    findLegacyEnvKeyUsages("- ${TRAEFIK_BASIC_AUTH_USER}\n- ${GATUS_BASIC_AUTH_BASE64}"),
    [],
  )
})

Deno.test("findLegacyEnvKeyUsages: flags any ${X_SUBDOMAIN}", () => {
  assertEquals(findLegacyEnvKeyUsages("Host(`${NTFY_SUBDOMAIN}.${DOMAIN}`)"), ["NTFY_SUBDOMAIN"])
})

Deno.test("findLegacyEnvKeyUsages: flags an unprefixed ${SMTP_...} but not a stack-prefixed one", () => {
  assertEquals(
    findLegacyEnvKeyUsages("- EMAIL_HOST=${SMTP_HOST}\n- EMAIL_HOST=${GITEA_SMTP_HOST}"),
    ["SMTP_HOST"],
  )
})

Deno.test("findLegacyEnvKeyUsages: a clean file reports nothing", () => {
  assertEquals(
    findLegacyEnvKeyUsages(
      "- ${TRAEFIK_BASIC_AUTH_USER}\nHost(`${NTFY_DOMAIN}`)\n- ${GITEA_SMTP_HOST}",
    ),
    [],
  )
})

Deno.test("catalog: no stack's compose.yml or deploy hook references a dropped legacy env key", async () => {
  const stacksDir = fromFileUrl(new URL("../stacks", import.meta.url))
  const violations: string[] = []

  for await (const entry of Deno.readDir(stacksDir)) {
    if (!entry.isDirectory) continue
    for (const fileName of ["compose.yml", "before.deploy.ts", "after.deploy.ts"]) {
      const path = join(stacksDir, entry.name, fileName)
      const text = await readIfExists(path)
      if (!text) continue
      for (const key of findLegacyEnvKeyUsages(text)) {
        violations.push(`${entry.name}/${fileName}: references legacy key ${key}`)
      }
    }
  }

  assertEquals(violations, [], violations.join("\n"))
})
