// Stack addition flow.
//
// Per docs/v1-cli.md §3.1 step 3:
//
//   1. Pick a stack from the bundled catalog.
//   2. Run that stack's variable flow (for each VariableSpec: --var
//      override > function default > string default > prompt-or-skip).
//
// Writes `servers/<name>/.env` and updates `servers/<name>/config.json`.
// Re-encrypts `.env` to `.env.age` at the end.
//
// Server-level vars (.env.root) propagate to the stack's .env so docker
// compose sees them. This is the v1 implementation of "server-level vars
// resolved before stack vars" (docs/v1-cli.md §4).

import { join } from "@std/path"
import { encryptEnvFiles } from "./encrypt.ts"
import {
  type EnvEntry,
  mergeEnv,
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

/** Result of a stack-add invocation. */
export interface StackAddResult {
  stackName: string
  serverName: string
  /** Variables actually written (after applying the prompt rule). */
  writtenEntries: EnvEntry[]
  /** Variables that were skipped (required:false, no default). */
  skippedKeys: string[]
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
  const catalog = await resolveCatalog(opts.catalogDir)
  const entry = findStack(catalog, stackName)

  // Build server context from `servers/<server>/.env` (per-server vars).
  // Phase 5: server-create writes there; .env.root is cross-server only.
  const ctx = opts.skipServerPropagation
    ? null
    : serverContextFromRoot(await readEnvFile(join(cwd, "servers", serverName, ".env")))

  const writtenEntries: EnvEntry[] = []
  const skippedKeys: string[] = []

  for (const spec of entry.meta.variables) {
    const normalized = normalizeVariableSpec(spec)
    const resolved = ctx
      ? resolveVariable(normalized, opts.providedVars?.[normalized.key], ctx)
      : resolvedSkipContext(normalized, opts.providedVars?.[normalized.key])

    const decision = decidePrompt(normalized, resolved?.value)
    let value: string | undefined

    if (decision === "use-resolved" && resolved) {
      value = resolved.value
    } else if (decision === "prompt") {
      const fallback = typeof normalized.default === "function"
        ? normalized.default()
        : normalized.default
      value = await promptValue({
        label: normalized.question ?? normalized.key,
        fallback,
        secret: normalized.secret,
        nonInteractive: !!opts.nonInteractive,
      })
    } else {
      // skip
      skippedKeys.push(normalized.key)
      continue
    }

    writtenEntries.push({ key: normalized.key, value })
  }

  // Write servers/<server>/.env. Merge with any existing entries so
  // hand-edits to non-managed keys are preserved (per docs/v1-cli.md §7).
  const serverDir = join(cwd, "servers", serverName)
  const envPath = join(serverDir, ".env")
  await Deno.mkdir(serverDir, { recursive: true })
  const existing = await readEnvFile(envPath)

  // Propagate every server-level var from .env.root into the stack's .env
  // (minus keys the stack already declared — those win via the merge).
  // filebrowser/+meta.ts:11 documents this: "Phase 5 wizard propagates
  // them to each stack's .env". Iterating all keys (instead of a
  // hardcoded allow-list) catches PATH_*, PATH_APPS, and any future
  // server-level var without code changes.
  const stackKeys = new Set(writtenEntries.map((e) => e.key))
  const propagated: EnvEntry[] = []
  if (ctx && !opts.skipServerPropagation) {
    for (const [key, value] of Object.entries(ctx)) {
      if (typeof value !== "string" || value === "") continue
      if (stackKeys.has(key)) continue
      propagated.push({ key, value })
    }
  }

  // `existing` is the base (hand-edits survive); propagated server vars
  // + the stack's written entries are the incoming layer. mergeEnv keeps
  // existing keys that aren't in incoming, then appends incoming in order
  // — stack-declared keys override server-level values on collision, and
  // hand-edited keys (not in incoming) are preserved untouched.
  const merged = mergeEnv(existing, propagated.concat(writtenEntries))
  await writeEnvFile(envPath, merged)

  // Update servers/<server>/config.json with the stack list.
  await updateServerConfig(serverDir, entry)

  // Re-encrypt servers/<server>/.env → .env.age (non-fatal).
  await encryptEnvFiles(cwd)

  return {
    stackName,
    serverName,
    writtenEntries,
    skippedKeys,
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
