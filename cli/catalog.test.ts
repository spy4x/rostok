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

import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert"
import { fromFileUrl, join, relative } from "@std/path"
import { findStack, loadCatalog, StackNotFoundError } from "./catalog.ts"
import { hasReservedStackKeyPrefix, isServerKey, stackKeyPrefix } from "./server-keys.ts"
import { UserError } from "./errors.ts"
import type { StackMeta } from "./stack-meta.ts"

// #236 item 3 — `StackNotFoundError` lets stack-remove.ts's `tryFindStack`
// tell "not found" apart from "ambiguous" by class, not by matching the
// thrown message's text (a reworded message used to silently break that
// check). `findStack` throws it ONLY for the not-found case.
Deno.test("findStack: not found throws StackNotFoundError", () => {
  const err = assertThrows(() => findStack([], "nope"), UserError)
  assertInstanceOf(err, StackNotFoundError)
})

Deno.test("findStack: an ambiguous match throws a plain UserError, not StackNotFoundError", () => {
  const dup: StackMeta = { name: "dup", description: "fixture", variables: [] }
  const catalog = [{ name: "foo", meta: dup }, { name: "bar", meta: dup }]
  const err = assertThrows(() => findStack(catalog, "dup"), UserError)
  assertEquals(err instanceof StackNotFoundError, false)
})

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

/**
 * Flag a hook that reads `SSH_ADDRESS` and hands the same identifier to
 * an `ssh`/`rsync` spawn — the #229 bug (a "host:port" SSH_ADDRESS reads
 * as one unresolvable hostname once handed to ssh/rsync directly). A
 * hook should build its argv from the SSH_HOST/SSH_PORT/SSH_USER
 * contract keys instead (already parsed once by cli/deploy/hooks.ts's
 * buildHookEnv) — see docs/contributing/adding-services.md's
 * hook-contract section.
 *
 * Static scan, not a real flow analysis: finds every identifier assigned
 * directly from `Deno.env.get("SSH_ADDRESS")`, then checks whether that
 * identifier's own name appears near an `ssh`/`rsync` spawn (`new
 * Deno.Command("ssh"|"rsync", ...)` or `runCommand(["ssh"|"rsync", ...)`
 * — the two spawn shapes every catalog hook actually uses). Good enough
 * to catch "this hook read SSH_ADDRESS and gave it straight to ssh",
 * which is the only shape #229 found across the catalog; it isn't a
 * general dataflow prover.
 */
export function findRawSshAddressSpawns(hookText: string): string[] {
  const violations: string[] = []
  const identRe =
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*Deno\.env\.get\(\s*["']SSH_ADDRESS["']\s*\)/g
  const idents = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = identRe.exec(hookText)) !== null) idents.add(m[1])
  if (idents.size === 0) return violations

  const spawnRe =
    /(?:new\s+Deno\.Command\(\s*["'](ssh|rsync)["']|runCommand\(\s*\[\s*["'](ssh|rsync)["'])/g
  while ((m = spawnRe.exec(hookText)) !== null) {
    const program = m[1] ?? m[2]
    // The call's own argument list — a fixed window is enough for every
    // real spawn shape in this catalog (each is a few lines).
    const window = hookText.slice(m.index, Math.min(hookText.length, m.index + 400))
    for (const ident of idents) {
      if (new RegExp(`\\b${ident}\\b`).test(window)) {
        violations.push(`spawns ${program} using raw SSH_ADDRESS (via "${ident}")`)
        break
      }
    }
  }
  return violations
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

  // 6. #212 — a stack with a Traefik router label needs traefik on the
  // same server before it works at all. traefik itself doesn't require
  // itself. A plain text search for the label (not `findHostRules`,
  // which only looks at the value inside `Host(...)`) — the point here
  // is "does this compose file wire itself into Traefik at all", not
  // the specific domain it uses (check 4 above already covers that).
  if (composeText && name !== "traefik" && composeText.includes("traefik.http.routers")) {
    if (!(meta.requires ?? []).includes("traefik")) {
      violations.push(
        `compose.yml declares a traefik.http.routers label but +meta.ts doesn't requires: ["traefik"]`,
      )
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

/**
 * Check the catalog's `requires` graph as a whole (review fix, #212):
 * every `requires` entry must name a stack that actually exists in the
 * catalog, no stack may require itself, and no cycle (`a` requires `b`,
 * `b` requires `a`, or a longer loop) may exist — `stackAdd`'s own
 * runtime guard stops a cycle from recursing forever, but a cycle
 * should never ship in the bundled catalog in the first place.
 */
export function checkRequiresGraph(entries: { name: string; meta: StackMeta }[]): Violation[] {
  const violations: Violation[] = []
  const byName = new Map(entries.map((e) => [e.name, e]))

  for (const entry of entries) {
    for (const req of entry.meta.requires ?? []) {
      if (req === entry.name) {
        violations.push(`${entry.name}: requires itself`)
        continue
      }
      if (!byName.has(req)) {
        violations.push(`${entry.name}: requires unknown stack "${req}"`)
      }
    }
  }

  // DFS cycle detection over edges whose target exists in the catalog —
  // an unknown-target edge is already reported above and shouldn't also
  // produce a confusing "cycle" report. Classic white/gray/black DFS:
  // `onStack` is the current path (gray), `visited` is fully explored
  // (black) — a back-edge into `onStack` is a cycle.
  const visited = new Set<string>()
  const onStack = new Set<string>()
  const cycles: string[][] = []

  const dfs = (name: string, path: string[]) => {
    onStack.add(name)
    path.push(name)
    const reqs = (byName.get(name)?.meta.requires ?? []).filter(
      (r) => byName.has(r) && r !== name,
    )
    for (const req of reqs) {
      if (onStack.has(req)) {
        const start = path.indexOf(req)
        cycles.push([...path.slice(start), req])
      } else if (!visited.has(req)) {
        dfs(req, path)
      }
    }
    path.pop()
    onStack.delete(name)
    visited.add(name)
  }

  for (const name of byName.keys()) {
    if (!visited.has(name)) dfs(name, [])
  }

  // Dedupe cycles that are rotations of the same loop (a→b→a walked
  // from "a" and, if the traversal ever restarted from "b", the same
  // loop walked from "b" — same cycle, different starting point).
  const seenCanonical = new Set<string>()
  for (const cycle of cycles) {
    const core = cycle.slice(0, -1) // drop the repeated closing node
    const canonical = core
      .map((_, i) => [...core.slice(i), ...core.slice(0, i)].join(","))
      .sort()[0]
    if (seenCanonical.has(canonical)) continue
    seenCanonical.add(canonical)
    violations.push(`requires cycle: ${cycle.join(" -> ")}`)
  }

  return violations
}

Deno.test("catalog: every requires entry names an existing stack, with no self-reference and no cycles", () => {
  const catalog = loadCatalog()
  const violations = checkRequiresGraph(catalog)
  assertEquals(violations, [], violations.join("\n"))
})

Deno.test("checkRequiresGraph: flags a requires entry naming a stack not in the catalog", () => {
  const entries = [
    { name: "web", meta: { name: "web", description: "x", variables: [], requires: ["ghost"] } },
  ]
  const violations = checkRequiresGraph(entries)
  assertEquals(violations.some((v) => v.includes('requires unknown stack "ghost"')), true)
})

Deno.test("checkRequiresGraph: flags a stack requiring itself", () => {
  const entries = [
    { name: "web", meta: { name: "web", description: "x", variables: [], requires: ["web"] } },
  ]
  const violations = checkRequiresGraph(entries)
  assertEquals(violations.some((v) => v.includes("requires itself")), true)
})

Deno.test("checkRequiresGraph: flags a two-stack cycle (a -> b -> a), reported once", () => {
  const entries = [
    { name: "a", meta: { name: "a", description: "x", variables: [], requires: ["b"] } },
    { name: "b", meta: { name: "b", description: "x", variables: [], requires: ["a"] } },
  ]
  const violations = checkRequiresGraph(entries)
  const cycleViolations = violations.filter((v) => v.startsWith("requires cycle"))
  assertEquals(cycleViolations.length, 1, violations.join("\n"))
  assertEquals(cycleViolations[0].includes("a -> b -> a"), true)
})

Deno.test("checkRequiresGraph: accepts a plain one-level requires (web -> traefik, traefik -> nothing)", () => {
  const entries = [
    { name: "traefik", meta: { name: "traefik", description: "x", variables: [] } },
    {
      name: "web",
      meta: { name: "web", description: "x", variables: [], requires: ["traefik"] },
    },
  ]
  const violations = checkRequiresGraph(entries)
  assertEquals(violations, [])
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

// #212 — a stack that wires itself into Traefik must declare
// requires: ["traefik"], so `stack add`/the wizard can offer (or,
// non-interactively, automatically add) the dependency first.

Deno.test('checkStack: flags a traefik router label with no requires: ["traefik"]', async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(
      `${dir}/compose.yml`,
      "labels:\n" +
        '  - "traefik.http.routers.acme.rule=Host(`${ACME_DOMAIN}`)"\n',
    )
    const meta: StackMeta = {
      name: "acme",
      description: "test",
      variables: [],
    }
    const violations = await checkStack(dir, "acme", meta, new Map())
    assertEquals(
      violations.some((v) => v.includes("traefik.http.routers") && v.includes("requires")),
      true,
    )
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('checkStack: accepts a traefik router label when requires: ["traefik"] is declared', async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(
      `${dir}/compose.yml`,
      "labels:\n" +
        '  - "traefik.http.routers.acme.rule=Host(`${ACME_DOMAIN}`)"\n',
    )
    const meta: StackMeta = {
      name: "acme",
      description: "test",
      variables: [],
      requires: ["traefik"],
    }
    const violations = await checkStack(dir, "acme", meta, new Map())
    assertEquals(violations.some((v) => v.includes("requires")), false)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("checkStack: traefik itself is exempt (doesn't require itself)", async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(
      `${dir}/compose.yml`,
      "labels:\n" +
        '  - "traefik.http.routers.dashboard.rule=Host(`${TRAEFIK_DOMAIN}`)"\n',
    )
    const meta: StackMeta = {
      name: "traefik",
      description: "test",
      variables: [],
    }
    const violations = await checkStack(dir, "traefik", meta, new Map())
    assertEquals(violations.some((v) => v.includes("requires")), false)
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
// Guard tests — two complementary checks, both against the live repo:
//
//   A. A small explicit ban list of legacy names that a prefix could
//      still hide (a key like `TRAEFIK_HOMELAB_USER` would pass a naive
//      "is it prefixed" check but is still wrong): `HOMELAB_USER`,
//      `homelab_user` (the ansible var), any `VPN_*` key, any
//      `${X_SUBDOMAIN}`, and a `BASIC_AUTH_` key without the
//      `TRAEFIK_`/`GATUS_` prefix. Scans ansible/, scripts/, cli/ and
//      stacks/ — not just stacks/, since the rename touched playbooks
//      and CLI code too.
//   B. The general rule every stack must follow: every key a
//      compose.yml or deploy hook reads from the host env (`${VAR}`
//      inside compose, `Deno.env.get("VAR")` or a `keys`-array inside a
//      hook) is either a server key (`isServerKey()`) or carries that
//      stack's own `stackKeyPrefix()`. Runs against every stacks/*
//      directory, not just the ones with a `+meta.ts` — most stacks
//      (ntfy, wireguard, gitea, open-webui, ...) don't have one yet.
// ─────────────────────────────────────────────────────────────────────

/**
 * Either form of a compose variable substitution: `${VAR}` (with an
 * optional bash default/error/alt suffix, captured in group 1) or the
 * bare `$VAR` (group 2) compose also accepts. The negative lookbehind
 * excludes docker-compose's `$${VAR}` escape (a literal `$` passed
 * through to the container's own shell, not a host substitution) — see
 * caldiy's cron loop in compose.yml.
 */
const VAR_REF = /(?<!\$)\$(?:\{([A-Z][A-Z0-9_]*)(?:[:?+-][^}]*)?\}|([A-Z][A-Z0-9_]*))/g

/** Every host var key `text` references, braced or bare (see VAR_REF). */
function matchAllHostVarKeys(text: string): string[] {
  const out: string[] = []
  for (const match of text.matchAll(VAR_REF)) out.push(match[1] ?? match[2])
  return out
}

/**
 * Every bare, quoted identifier in `text` — `"KEY"`, `'KEY'` or `` `KEY` ``
 * — the form a key name takes in `Deno.env.get("KEY")`, a hook's own
 * `getEnv("KEY")` wrapper, ansible's `lookup('env', 'KEY')`, or a plain
 * string-literal array, plus every `.KEY` property read in upper snake
 * case (`env.KEY`, `Deno.env.toObject().KEY`). Case-insensitive at the
 * token level for quoted names (the caller decides what counts as banned)
 * so it also catches `homelab_user`. A text scan, not a parser: a name
 * assembled at runtime (`"BASIC_" + "AUTH_USER"`) still gets through.
 */
function matchAllQuotedIdentifiers(text: string): string[] {
  const out: string[] = []
  const quoted = /["'`]([A-Za-z][A-Za-z0-9_]*)["'`]/g
  for (const match of text.matchAll(quoted)) out.push(match[1])
  const property = /\.([A-Z][A-Z0-9_]*)\b/g
  for (const match of text.matchAll(property)) out.push(match[1])
  return out
}

/**
 * True for a dropped legacy env key name: `HOMELAB_USER`/`homelab_user`
 * (the ansible var this repo renamed to `ssh_user`), any `VPN_*` key, a
 * `BASIC_AUTH_` key without the `TRAEFIK_`/`GATUS_` prefix, or any
 * `*_SUBDOMAIN` key.
 */
function isBannedLegacyKey(key: string): boolean {
  if (key === "HOMELAB_USER" || key === "homelab_user") return true
  if (/^VPN_/.test(key)) return true
  if (key.endsWith("_SUBDOMAIN")) return true
  if (key.includes("BASIC_AUTH_") && !key.startsWith("TRAEFIK_") && !key.startsWith("GATUS_")) {
    return true
  }
  return false
}

/**
 * Scan `text` for a reference to a legacy env key name (see
 * `isBannedLegacyKey`), in any of the forms it can appear in: a compose
 * `${VAR}`/bare `$VAR` substitution, or a bare quoted identifier —
 * `"BASIC_AUTH_USER"`, `'VPN_PEERS'`, `Deno.env.get("SYNCTHING_SUBDOMAIN")`,
 * `lookup('env', 'VPN_PEERS')`, `getEnv("BASIC_AUTH_USER")`. Returns the
 * offending key for each match found.
 */
export function findLegacyEnvKeyUsages(text: string): string[] {
  const found: string[] = []
  // Ansible's `{{ homelab_user }}` (Jinja) has neither a `$` nor quotes
  // around the name, so it needs its own bare word-boundary check.
  if (/\bHOMELAB_USER\b/.test(text)) found.push("HOMELAB_USER")
  if (/\bhomelab_user\b/.test(text)) found.push("homelab_user")
  for (const key of matchAllHostVarKeys(text)) {
    if (isBannedLegacyKey(key)) found.push(key)
  }
  for (const key of matchAllQuotedIdentifiers(text)) {
    if (isBannedLegacyKey(key)) found.push(key)
  }
  return found
}

Deno.test("findLegacyEnvKeyUsages: flags backtick strings and property reads", () => {
  assertEquals(findLegacyEnvKeyUsages("getEnv(`BASIC_AUTH_USER`)"), ["BASIC_AUTH_USER"])
  assertEquals(findLegacyEnvKeyUsages("const p = env.VPN_PEERS"), ["VPN_PEERS"])
  assertEquals(
    findLegacyEnvKeyUsages("Deno.env.toObject().BASIC_AUTH_USER"),
    ["BASIC_AUTH_USER"],
  )
})

Deno.test("findLegacyEnvKeyUsages: flags HOMELAB_USER and homelab_user", () => {
  assertEquals(findLegacyEnvKeyUsages("owner: {{ HOMELAB_USER }}"), ["HOMELAB_USER"])
  assertEquals(findLegacyEnvKeyUsages("owner: {{ homelab_user }}"), ["homelab_user"])
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

Deno.test("findLegacyEnvKeyUsages: flags a bare quoted key, not just $VAR/\${VAR}", () => {
  assertEquals(findLegacyEnvKeyUsages('key: "BASIC_AUTH_USER"'), ["BASIC_AUTH_USER"])
  assertEquals(findLegacyEnvKeyUsages("key: 'VPN_PEERS'"), ["VPN_PEERS"])
})

Deno.test("findLegacyEnvKeyUsages: flags Deno.env.get(...) / getEnv(...) / ansible lookup(...) forms", () => {
  assertEquals(
    findLegacyEnvKeyUsages('Deno.env.get("SYNCTHING_SUBDOMAIN")'),
    ["SYNCTHING_SUBDOMAIN"],
  )
  assertEquals(
    findLegacyEnvKeyUsages("\"{{ lookup('env', 'VPN_PEERS') }}\""),
    ["VPN_PEERS"],
  )
  assertEquals(
    findLegacyEnvKeyUsages('getEnv("BASIC_AUTH_USER")'),
    ["BASIC_AUTH_USER"],
  )
})

Deno.test("findLegacyEnvKeyUsages: flags any VPN_* key", () => {
  assertEquals(findLegacyEnvKeyUsages("- PEERS=${VPN_PEERS}"), ["VPN_PEERS"])
})

Deno.test("findLegacyEnvKeyUsages: ignores docker compose's $${VAR} escape", () => {
  assertEquals(findLegacyEnvKeyUsages('- "authorization: $${CRON_API_KEY}"'), [])
})

Deno.test("findLegacyEnvKeyUsages: a clean file reports nothing", () => {
  assertEquals(
    findLegacyEnvKeyUsages(
      "- ${TRAEFIK_BASIC_AUTH_USER}\nHost(`${NTFY_DOMAIN}`)\n- ${WIREGUARD_PEERS}",
    ),
    [],
  )
})

/** Recursively list files under `dir` whose name ends with one of `extensions`. */
async function listFiles(dir: string, extensions: string[]): Promise<string[]> {
  const out: string[] = []
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory) {
      out.push(...await listFiles(path, extensions))
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(path)
    }
  }
  return out
}

/**
 * Test files that deliberately assert a legacy key is rejected or has no
 * effect — their fixtures legitimately contain the banned strings this
 * test bans everywhere else. Paths are relative to the repo root
 * (`cli/../..` from this file). Every other file, including every other
 * `*.test.ts`, is scanned like any source file — a test file is not a
 * blanket exemption.
 */
const ALLOW_LISTED_LEGACY_MENTIONS: readonly string[] = [
  // This file's own fixtures for the checker functions above.
  "cli/catalog.test.ts",
  // Assert a .env with only the legacy key has no remote user / GID.
  "cli/deploy/env.test.ts",
  "scripts/ansible/inventory.test.ts",
  "stacks/syncthing/before.deploy.test.ts",
  // Asserts the legacy BASIC_AUTH_* branch is gone (throws, not read).
  "stacks/traefik/before.deploy.test.ts",
]

Deno.test("repo: no ansible/scripts/cli/stacks file references a banned legacy env key", async () => {
  const violations: string[] = []
  const repoRoot = fromFileUrl(new URL("..", import.meta.url))
  const targets: Array<{ dir: string; extensions: string[] }> = [
    { dir: fromFileUrl(new URL("../ansible", import.meta.url)), extensions: [".yml", ".yaml"] },
    { dir: fromFileUrl(new URL("../scripts", import.meta.url)), extensions: [".ts"] },
    { dir: fromFileUrl(new URL(".", import.meta.url)), extensions: [".ts"] },
    { dir: fromFileUrl(new URL("../stacks", import.meta.url)), extensions: [".yml", ".ts"] },
  ]

  for (const { dir, extensions } of targets) {
    for (const path of await listFiles(dir, extensions)) {
      const relPath = relative(repoRoot, path)
      if (ALLOW_LISTED_LEGACY_MENTIONS.includes(relPath)) continue
      const text = await Deno.readTextFile(path)
      for (const key of findLegacyEnvKeyUsages(text)) {
        violations.push(`${relPath}: references legacy key ${key}`)
      }
    }
  }

  assertEquals(violations, [], violations.join("\n"))
})

/**
 * Every `Deno.env.get("KEY")` call, every bare `getEnv("KEY")` call (the
 * callback a hook takes to stay pure and testable — see
 * `stacks/traefik/before.deploy.ts`'s `resolveHtpasswdCredential`), plus
 * every `SCREAMING_SNAKE_CASE` string literal inside a `const keys =
 * [...]` array (the "required env vars" list pattern used by e.g.
 * stalwart/email-mcp's before.deploy.ts) — the ways a `*.deploy.ts` hook
 * reads a host env key.
 */
export function findDeployTsHostKeys(text: string): string[] {
  const out: string[] = []
  const getRe = /\b(?:Deno\.env\.get|getEnv)\(\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*[,)]/g
  for (const m of text.matchAll(getRe)) out.push(m[1])
  const arrMatch = /const\s+keys\s*=\s*\[([^\]]*)\]/.exec(text)
  if (arrMatch) {
    const litRe = /["'`]([A-Z][A-Z0-9_]*)["'`]/g
    for (const m of arrMatch[1].matchAll(litRe)) out.push(m[1])
  }
  return out
}

Deno.test("findDeployTsHostKeys: reads a backtick-quoted key", () => {
  assertEquals(findDeployTsHostKeys("const x = Deno.env.get(`ACME_TOKEN`)"), ["ACME_TOKEN"])
})

Deno.test("findDeployTsHostKeys: reads Deno.env.get(...) calls", () => {
  assertEquals(
    findDeployTsHostKeys('const x = Deno.env.get("ACME_TOKEN") ?? ""'),
    ["ACME_TOKEN"],
  )
})

Deno.test("findDeployTsHostKeys: reads a bare getEnv(...) call (a hook's injected callback)", () => {
  assertEquals(
    findDeployTsHostKeys('const user = getEnv("TRAEFIK_BASIC_AUTH_USER")'),
    ["TRAEFIK_BASIC_AUTH_USER"],
  )
})

Deno.test("findDeployTsHostKeys: reads a required-keys array literal", () => {
  assertEquals(
    findDeployTsHostKeys('const keys = ["DOMAIN", "ACME_TOKEN"] as const'),
    ["DOMAIN", "ACME_TOKEN"],
  )
})

Deno.test(
  "catalog: every host-env key a stack's compose.yml/hook reads is a server key or carries the stack's prefix",
  async () => {
    const stacksDir = fromFileUrl(new URL("../stacks", import.meta.url))
    const violations: string[] = []

    for await (const entry of Deno.readDir(stacksDir)) {
      if (!entry.isDirectory) continue
      const prefix = stackKeyPrefix(entry.name)
      // key -> first file seen reading it, for a useful violation message.
      const keys = new Map<string, string>()

      // Glob compose*.yml, not just compose.yml — a stack can ship
      // additional compose files for deploy variants (e.g.
      // home-assistant's compose.traefik.yml, compose.host.yml).
      const stackDir = join(stacksDir, entry.name)
      for await (const fileEntry of Deno.readDir(stackDir)) {
        if (!fileEntry.isFile || !/^compose.*\.ya?ml$/.test(fileEntry.name)) continue
        const composeRaw = await readIfExists(join(stackDir, fileEntry.name))
        if (!composeRaw) continue
        const compose = stripFullLineComments(composeRaw)
        for (const key of matchAllHostVarKeys(compose)) {
          if (!keys.has(key)) keys.set(key, fileEntry.name)
        }
      }
      for (const hookName of ["before.deploy.ts", "after.deploy.ts"]) {
        const hookText = await readIfExists(join(stacksDir, entry.name, hookName))
        if (!hookText) continue
        for (const key of findDeployTsHostKeys(hookText)) {
          if (!keys.has(key)) keys.set(key, hookName)
        }
      }

      for (const [key, file] of keys) {
        if (isServerKey(key)) continue
        if (key.startsWith(prefix)) continue
        violations.push(
          `${entry.name}/${file}: reads "${key}" — not a server key and missing the "${prefix}" prefix`,
        )
      }
    }

    assertEquals(violations, [], violations.join("\n"))
  },
)

Deno.test(
  "catalog: no stack's own key prefix is reserved (GIT_/DOCKER_/SSH_/...)",
  async () => {
    const stacksDir = fromFileUrl(new URL("../stacks", import.meta.url))
    const violations: string[] = []
    for await (const entry of Deno.readDir(stacksDir)) {
      if (!entry.isDirectory) continue
      if (hasReservedStackKeyPrefix(entry.name)) {
        violations.push(`${entry.name} -> prefix "${stackKeyPrefix(entry.name)}" is reserved`)
      }
    }
    assertEquals(violations, [], violations.join("\n"))
  },
)

Deno.test('findRawSshAddressSpawns: flags a var read from SSH_ADDRESS handed to Deno.Command("ssh")', () => {
  const text = `const SSH = Deno.env.get("SSH_ADDRESS") ?? ""\n` +
    `new Deno.Command("ssh", { args: [SSH, "docker", "restart", "x"] })\n`
  assertEquals(findRawSshAddressSpawns(text).length, 1)
})

Deno.test('findRawSshAddressSpawns: flags runCommand(["ssh", SSH, ...])', () => {
  const text = `const ssh = Deno.env.get("SSH_ADDRESS")\n` +
    `await runCommand(["ssh", ssh, "docker restart x"])\n`
  assertEquals(findRawSshAddressSpawns(text).length, 1)
})

Deno.test("findRawSshAddressSpawns: a hook using SSH_HOST/SSH_PORT (no SSH_ADDRESS) is clean", () => {
  const text = `const host = Deno.env.get("SSH_HOST")\n` +
    `const port = Deno.env.get("SSH_PORT") ?? "22"\n` +
    `new Deno.Command("ssh", { args: ["-p", port, "--", host, "docker", "restart", "x"] })\n`
  assertEquals(findRawSshAddressSpawns(text), [])
})

/**
 * Strip `//` line comments and block comments (`/star ... star/`) from TS source —
 * naive (doesn't understand strings that happen to contain `//` or
 * `/*`), but every catalog hook file is plain, so this is sufficient
 * to keep a comment mentioning "SSH_ADDRESS" (documentation, like this
 * very file's own module comments) from tripping the check below.
 */
export function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
}

/**
 * True when `hookText` mentions `SSH_ADDRESS` at all outside a comment
 * — a `Deno.env.get("SSH_ADDRESS")`, a hook's injected `getEnv(...)`
 * callback reading it, or any other reference. #229's fix means every
 * catalog hook gets SSH_HOST/SSH_PORT/SSH_USER as contract keys
 * already parsed by cli/deploy/hooks.ts — a hook has no legitimate
 * reason to read SSH_ADDRESS at all any more, so the rule is now a flat
 * "never mentioned", not just "never handed to an ssh/rsync spawn"
 * (the narrower, now-subsumed check `findRawSshAddressSpawns` above
 * still covers, in case a future contract key is added the same way).
 */
export function referencesSshAddress(hookText: string): boolean {
  return /SSH_ADDRESS/.test(stripTsComments(hookText))
}

Deno.test('referencesSshAddress: flags Deno.env.get("SSH_ADDRESS") even with no ssh/rsync spawn nearby', () => {
  const text = `const addr = Deno.env.get("SSH_ADDRESS") ?? ""\nconsole.log(addr)\n`
  assertEquals(referencesSshAddress(text), true)
})

Deno.test("referencesSshAddress: flags a bare string reference, not just Deno.env.get", () => {
  const text = `const keys = ["SSH_ADDRESS", "PATH_APPS"]\n`
  assertEquals(referencesSshAddress(text), true)
})

Deno.test("referencesSshAddress: a mention only inside a comment is not flagged", () => {
  const text = `// SSH_ADDRESS used to be read here; now uses SSH_HOST/SSH_PORT.\n` +
    `/* also mentioned in a block comment: SSH_ADDRESS */\n` +
    `const host = Deno.env.get("SSH_HOST")\n`
  assertEquals(referencesSshAddress(text), false)
})

Deno.test("referencesSshAddress: a hook using only SSH_HOST/SSH_PORT/SSH_USER is clean", () => {
  const text = `const host = Deno.env.get("SSH_HOST")\nconst port = Deno.env.get("SSH_PORT")\n` +
    `const user = Deno.env.get("SSH_USER")\n`
  assertEquals(referencesSshAddress(text), false)
})

Deno.test(
  "catalog: no stacks/*/*.deploy.ts reads SSH_ADDRESS at all any more (review round — #229)",
  async () => {
    const stacksDir = fromFileUrl(new URL("../stacks", import.meta.url))
    const violations: string[] = []
    for await (const entry of Deno.readDir(stacksDir)) {
      if (!entry.isDirectory) continue
      for (const hookName of ["before.deploy.ts", "after.deploy.ts"]) {
        const hookText = await readIfExists(join(stacksDir, entry.name, hookName))
        if (!hookText) continue
        if (referencesSshAddress(hookText)) {
          violations.push(`${entry.name}/${hookName}: still mentions SSH_ADDRESS`)
        }
      }
    }
    assertEquals(violations, [], violations.join("\n"))
  },
)
