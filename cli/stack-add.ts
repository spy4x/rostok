// Stack addition flow.
//
// Per docs/v1-cli.md §3.1 step 3:
//
//   1. Pick a stack from the bundled catalog.
//   2. Run that stack's variable flow (for each VariableSpec: --var
//      override > existing .env value (this covers a stack-declared key
//      that's also a server key, e.g. CONTACT_EMAIL, once server create
//      has written it) > function default > string default >
//      prompt-or-skip).
//
// Writes `servers/<name>/.env` and updates `servers/<name>/config.json`.
// Re-encrypts `.env` to `.env.age` at the end.
//
// #210: all stacks on a server share one `.env`. A value already there
// (written by an earlier `stack add`, or by `server create`) is kept
// unless the caller passes `--var` for that key — so re-running never
// clobbers another stack's key and never rotates an existing secret
// (`() => generatePassword()` only runs when the key is absent).

import { join, relative } from "@std/path"
import { encryptEnvFiles } from "./encrypt.ts"
import {
  type EnvEntry,
  mergeEnv,
  migrateSshUserKey,
  readEnvFile,
  serverContextFromRoot,
  writeEnvFile,
} from "./env-files.ts"
import { type CatalogEntry, findStack } from "./catalog.ts"
import { resolveCatalog } from "./catalog-paths.ts"
import { decidePrompt } from "./prompt-rule.ts"
import { resolveVariable } from "./defaults.ts"
import { normalizeVariableSpec } from "./stack-meta.ts"
import type { VariableSpec } from "./stack-meta.ts"
import { promptValue } from "./prompts.ts"
import { serverDirFor } from "./server-keys.ts"
import { UserError } from "./errors.ts"

/** Result of a stack-add invocation. */
export interface StackAddResult {
  stackName: string
  serverName: string
  /** Variables actually written (after applying the prompt rule). */
  writtenEntries: EnvEntry[]
  /** Variables that were skipped (required:false, no default). */
  skippedKeys: string[]
  /** Keys written for the first time by this run. */
  newCount: number
  /** Keys that already had a value, kept unchanged. */
  keptCount: number
}

export interface StackAddOptions {
  /** Project root. */
  cwd?: string
  /** Bundled catalog directory (defaults to <cwd>/../stacks in dev mode). */
  catalogDir?: string
  /** Per-variable overrides from --var KEY=VAL. */
  providedVars?: Record<string, string>
  /** Non-interactive: skip prompts; fail on any variable that can't be resolved. */
  nonInteractive?: boolean
  /** Skip server-level propagation (testing only). */
  skipServerPropagation?: boolean
}

/**
 * Add a stack to a server. Loads catalog, resolves variables against the
 * server context, writes `servers/<name>/.env` + `config.json`, and
 * re-encrypts.
 */
export async function stackAdd(
  stackName: string,
  serverName: string,
  opts: StackAddOptions = {},
): Promise<StackAddResult> {
  const cwd = opts.cwd ?? Deno.cwd()

  // #208: validate the server name before touching the filesystem.
  const serverDir = serverDirFor(cwd, serverName)
  const envPath = join(serverDir, ".env")

  // #210: a missing server fails loudly and writes nothing — stack add
  // never creates a server implicitly.
  const serverExists = await Deno.stat(envPath).then((s) => s.isFile).catch(() => false)
  if (!serverExists) {
    throw new UserError(`server "${serverName}" not found: run rostok server create ${serverName}`)
  }

  const catalog = await resolveCatalog(opts.catalogDir)
  const entry = findStack(catalog, stackName)

  const existingRaw = await readEnvFile(envPath)
  const { entries: existing, renamedFrom } = migrateSshUserKey(existingRaw)
  if (renamedFrom) {
    console.log(`rostok: renamed ${renamedFrom} to SSH_USER in ${relative(cwd, envPath)}`)
  }
  const existingByKey = new Map(existing.map((e) => [e.key, e.value]))

  // Build server context from `servers/<server>/.env` (per-server vars),
  // for `${DOMAIN}`-style substitution in string defaults. SERVER_NAME
  // isn't a key any `.env` ever stores (it's the directory name), so it's
  // added explicitly — otherwise the one reference the design doc
  // guarantees (`${SERVER_NAME}`) could never resolve.
  const ctx = opts.skipServerPropagation
    ? null
    : { ...serverContextFromRoot(existing), SERVER_NAME: serverName }

  const writtenEntries: EnvEntry[] = []
  const skippedKeys: string[] = []
  let newCount = 0
  let keptCount = 0

  for (const spec of entry.meta.variables) {
    const normalized = normalizeVariableSpec(spec)
    const key = normalized.key
    const providedValue = opts.providedVars?.[key]
    const existingValue = existingByKey.get(key)

    // 1. --var always wins, even over an existing value. A --var that
    //    happens to match what's already there is "kept", not "new" —
    //    it's not adding a value, just confirming one.
    if (providedValue !== undefined) {
      writtenEntries.push({ key, value: providedValue })
      if (providedValue === existingValue) keptCount++
      else newCount++
      continue
    }

    // 2. Keep whatever is already in .env — never clobber another
    //    stack's key, never regenerate a secret on re-run. This also
    //    covers a stack-declared key that's also a server key (e.g.
    //    traefik's CONTACT_EMAIL): server create already wrote it, so
    //    it's "existing" by the time any stack add runs.
    if (existingValue !== undefined) {
      writtenEntries.push({ key, value: existingValue })
      keptCount++
      continue
    }

    // 3. Function/string default, or prompt/skip. Only reached when the
    //    key has no value anywhere yet, so `() => generatePassword()`
    //    only runs on first add.
    const resolved = ctx
      ? resolveVariable(normalized, undefined, ctx)
      : resolvedSkipContext(normalized, undefined)

    const decision = decidePrompt(normalized, resolved?.value)
    let value: string | undefined

    if (decision === "use-resolved" && resolved) {
      value = resolved.value
    } else if (decision === "prompt") {
      const fallback = typeof normalized.default === "function" ? undefined : normalized.default
      value = await promptValue({
        key,
        label: normalized.question ?? key,
        fallback,
        secret: normalized.secret,
        nonInteractive: !!opts.nonInteractive,
      })
    } else {
      skippedKeys.push(key)
      continue
    }

    // #210 + review: an unresolved `${...}` left after default
    // resolution is an error naming the key — checked only for a value
    // this run just resolved from a default, not for whatever was
    // already sitting in .env (step 2 above never reaches here).
    const bad = value.match(/\$\{[^}]*\}/)
    if (bad) {
      throw new UserError(`unresolved reference in ${key}: ${bad[0]}`)
    }

    writtenEntries.push({ key, value })
    newCount++
  }

  // Write servers/<server>/.env. `existing` is the base so hand-edits to
  // non-declared keys survive; `writtenEntries` (existing values kept as-
  // is, plus anything new) is the incoming layer.
  const merged = mergeEnv(existing, writtenEntries)
  await writeEnvFile(envPath, merged)

  // Update servers/<server>/config.json with the stack list.
  await updateServerConfig(serverDir, entry)

  // Re-encrypt servers/<server>/.env → .env.age (non-fatal).
  await encryptEnvFiles(cwd)

  const valueWord = newCount === 1 ? "value" : "values"
  console.log(
    `added ${stackName} to ${serverName}: ${newCount} new ${valueWord}, ${keptCount} kept`,
  )

  return {
    stackName,
    serverName,
    writtenEntries,
    skippedKeys,
    newCount,
    keptCount,
  }
}

/**
 * Resolve a VariableSpec without a server context. Used by tests + the
 * rare case where the user invokes stack add before server-create.
 */
function resolvedSkipContext(
  spec: VariableSpec,
  providedValue: string | undefined,
) {
  if (providedValue !== undefined) return { value: providedValue, fromDefault: false }
  if (typeof spec.default === "function") {
    const v = spec.default()
    if (v !== undefined) return { value: v, fromDefault: true }
  }
  if (typeof spec.default === "string") return { value: spec.default, fromDefault: true }
  return null
}

/** Read or create servers/<n>/config.json with the new stack entry. */
async function updateServerConfig(serverDir: string, entry: CatalogEntry): Promise<void> {
  const configPath = join(serverDir, "config.json")
  type ConfigFile = { stacks: { name: string }[] }
  let cfg: ConfigFile = { stacks: [] }
  try {
    const text = await Deno.readTextFile(configPath)
    cfg = JSON.parse(text)
    if (!Array.isArray(cfg.stacks)) cfg.stacks = []
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err
  }
  if (!cfg.stacks.some((s) => s.name === entry.meta.name)) {
    cfg.stacks.push({ name: entry.meta.name })
  }
  await Deno.writeTextFile(configPath, JSON.stringify(cfg, null, 2) + "\n")
}
