// Stack removal flow — #225.
//
// The inverse of stack-add.ts: drop a stack's entry from
// `servers/<server>/config.json` and, on request, its own env keys from
// `servers/<server>/.env`. Never touches:
//
//   - a server-level key (isServerKey — SERVER_KEYS or any PATH_* key),
//     even when this stack's `+meta.ts` happens to declare it (e.g.
//     traefik's CONTACT_EMAIL — server create wrote it, stack add never
//     re-prompts for it, and removing traefik must not take it away
//     from every other stack that reads it);
//   - a key another still-installed stack's own `+meta.ts` declares —
//     #210 says two stacks never declare the same key, so this should
//     never fire in practice, but it's checked directly rather than
//     trusted, per #225's "double check" note;
//   - anything NOT declared by this stack's own `+meta.ts` (a hand-added
//     `.env` line that happens to share this stack's prefix is left
//     alone — only keys this stack itself would have written are ever
//     candidates for removal).
//
// Refuses to remove a stack another still-installed stack `requires`
// (#212), unless `--force` — resolved the same way `stack add`'s own
// `unmetRequires` check reads the graph (by the `name` config.json
// stores, i.e. each entry's `meta.name`).
//
// Review fix — every question is asked BEFORE any file is written:
// the old order wrote config.json first, then asked about .env. A
// decline (or a crash between the two) left config.json changed while
// .env wasn't, an inconsistent state for something a "did it work?"
// rerun couldn't cleanly retry. config.json and .env (when confirmed)
// are now written back to back, once the answer is known.
//
// Review fix — a stack that's in config.json but no longer resolves in
// the catalog (removed from a `--catalog` override, or dropped from the
// bundled catalog between versions) can still be removed: its
// config.json entry is dropped, but its own env keys are left alone —
// there's no `+meta.ts` left to say which keys are its own, and
// guessing by prefix could delete another stack's key.

import { join } from "@std/path"
import { reencryptAfterWrite } from "./reencrypt.ts"
import { readEnvFile, writeEnvFilePreservingFormat } from "./env-files.ts"
import { type CatalogEntry, findStack, StackNotFoundError } from "./catalog.ts"
import { resolveCatalog } from "./catalog-paths.ts"
import { normalizeVariableSpec } from "./stack-meta.ts"
import { type ConfirmFn, defaultConfirmFn } from "./prompts.ts"
import { isServerKey, serverDirFor } from "./server-keys.ts"
import { readServerConfig } from "./stack-add.ts"
import { serverNotFoundMessage, UserError } from "./errors.ts"

export interface StackRemoveOptions {
  /** Project root. */
  cwd?: string
  /** Bundled catalog directory (defaults to <cwd>/../stacks in dev mode). */
  catalogDir?: string
  /** Skip prompts: never asks about dropping env keys, just leaves them + notice. */
  nonInteractive?: boolean
  /** Remove the stack's own env keys without asking. Wins over the interactive prompt. */
  dropEnv?: boolean
  /** Remove even though another installed stack `requires` this one. */
  force?: boolean
  /** Test injection point for the "drop this stack's env keys?" yes/no prompt. */
  confirmFn?: ConfirmFn
}

export interface StackRemoveResult {
  stackName: string
  serverName: string
  /** This stack's own env keys that were actually deleted from .env. */
  droppedKeys: string[]
  /** This stack's own env keys that exist in .env but were left alone. */
  keptOwnKeys: string[]
  /**
   * True when `stackName` no longer resolves in the catalog — its
   * config.json entry was still removed, but env cleanup was skipped
   * entirely (no `+meta.ts` to say which keys are its own).
   */
  envCleanupSkipped?: boolean
}

/**
 * Try to resolve `stackName` in `catalog`; `undefined` instead of
 * throwing only when it's genuinely not there. `findStack` also throws
 * for an AMBIGUOUS name (matches more than one entry) — that's a real
 * bug in the catalog, not "gone from the catalog", so it must propagate
 * rather than being swallowed into a silent "treat it as delisted".
 *
 * #236: distinguishes the two cases by catching `StackNotFoundError`
 * specifically, not by matching the thrown message's text — a reworded
 * "not found in catalog" message used to silently stop being recognized
 * here (and an ambiguous-name message that happened to contain that
 * substring would have been wrongly swallowed too).
 */
function tryFindStack(catalog: CatalogEntry[], stackName: string): CatalogEntry | undefined {
  try {
    return findStack(catalog, stackName)
  } catch (err) {
    if (err instanceof StackNotFoundError) {
      return undefined
    }
    throw err
  }
}

/**
 * Remove a stack from a server: drops it from `config.json`, and — on
 * confirmation, `--drop-env`, or never in non-interactive mode without
 * that flag — its own env keys from `.env`. Re-encrypts afterward, same
 * as `stackAdd`. Every question is asked before anything is written.
 */
export async function stackRemove(
  stackName: string,
  serverName: string,
  opts: StackRemoveOptions = {},
): Promise<StackRemoveResult> {
  const cwd = opts.cwd ?? Deno.cwd()
  const serverDir = serverDirFor(cwd, serverName)
  const envPath = join(serverDir, ".env")

  const serverExists = await Deno.stat(envPath).then((s) => s.isFile).catch(() => false)
  if (!serverExists) {
    throw new UserError(serverNotFoundMessage(serverName, envPath))
  }

  const catalog = await resolveCatalog(opts.catalogDir)
  const entry = tryFindStack(catalog, stackName)
  // `resolvedName` is what config.json actually stores: `entry.meta.name`
  // when the catalog still knows the stack, otherwise the raw name the
  // caller passed (it must match a config.json entry exactly — there's
  // no alias resolution left once the catalog can't help).
  const resolvedName = entry?.meta.name ?? stackName

  const cfg = await readServerConfig(serverDir)
  if (!cfg.stacks.some((s) => s.name === resolvedName)) {
    throw new UserError(`stack '${resolvedName}' is not installed on '${serverName}'`)
  }

  // #225 — refuse when another still-installed stack `requires` this
  // one, naming the dependent(s), unless --force. A dependent whose own
  // `+meta.ts` can't be resolved is skipped rather than crashing the
  // removal — there's nothing to name it by anyway. Works whether or
  // not `entry` itself resolved, since `requires` graphs reference
  // `resolvedName` either way.
  const dependents: string[] = []
  for (const installed of cfg.stacks) {
    if (installed.name === resolvedName) continue
    const depEntry = tryFindStack(catalog, installed.name)
    if (!depEntry) continue
    if ((depEntry.meta.requires ?? []).includes(resolvedName)) {
      dependents.push(installed.name)
    }
  }
  if (dependents.length > 0 && !opts.force) {
    throw new UserError(
      `can't remove '${resolvedName}': required by ${
        dependents.join(", ")
      } — pass --force to remove anyway.`,
    )
  }

  const remainingStacks = cfg.stacks.filter((s) => s.name !== resolvedName)

  const result: StackRemoveResult = {
    stackName: resolvedName,
    serverName,
    droppedKeys: [],
    keptOwnKeys: [],
  }

  if (!entry) {
    // No `+meta.ts` left to say which env keys are this stack's own —
    // guessing by prefix could delete another stack's key, so env
    // cleanup is skipped outright rather than attempted unsafely. .env
    // itself never changes in this branch, so there's nothing for
    // encryptEnvFiles to do — config.json isn't something it touches.
    await writeConfig(serverDir, cfg, remainingStacks)
    result.envCleanupSkipped = true
    console.log(
      `rostok: '${resolvedName}' isn't in the catalog anymore — removed it from ` +
        `${serverName}'s config.json, but left its values in servers/${serverName}/.env alone ` +
        `(no +meta.ts left to say which keys are its own). Remove them by hand if you no ` +
        `longer need them.`,
    )
    return result
  }

  // Candidate keys: only what THIS stack's own +meta.ts declares (never
  // "anything with a matching prefix" — see module comment), minus any
  // server-level key, minus anything another still-installed stack also
  // declares (#210 says this can't happen; checked anyway per #225).
  const ownDeclaredKeys = new Set(
    entry.meta.variables.map((v) => normalizeVariableSpec(v).key),
  )
  const otherDeclaredKeys = new Set<string>()
  for (const installed of remainingStacks) {
    const otherEntry = tryFindStack(catalog, installed.name)
    if (!otherEntry) continue
    for (const v of otherEntry.meta.variables) {
      otherDeclaredKeys.add(normalizeVariableSpec(v).key)
    }
  }

  const existing = await readEnvFile(envPath)
  const candidateKeys = existing
    .map((e) => e.key)
    .filter((key) => ownDeclaredKeys.has(key) && !isServerKey(key) && !otherDeclaredKeys.has(key))
  result.keptOwnKeys = [...candidateKeys]

  // Decide whether to drop the env keys BEFORE writing anything — see
  // the module comment on write ordering.
  let shouldDrop = false
  if (candidateKeys.length > 0) {
    if (opts.dropEnv) {
      shouldDrop = true
    } else if (opts.nonInteractive) {
      console.log(
        `rostok: kept ${candidateKeys.length} ${
          candidateKeys.length === 1 ? "value" : "values"
        } for ${resolvedName} in servers/${serverName}/.env (${
          candidateKeys.join(", ")
        }) — pass --drop-env to remove them, or run interactively.`,
      )
    } else {
      const confirmFn = opts.confirmFn ?? defaultConfirmFn
      shouldDrop = await confirmFn({
        message: `Also remove ${resolvedName}'s own values from servers/${serverName}/.env (${
          candidateKeys.join(", ")
        })?`,
        default: false,
      })
      if (!shouldDrop) {
        console.log(
          `rostok: kept ${resolvedName}'s values in servers/${serverName}/.env — remove them ` +
            `later by hand, or re-run \`rostok stack remove ${resolvedName} -s ${serverName} ` +
            `--drop-env\`.`,
        )
      }
    }
  }

  // Now write: config.json unconditionally, .env only if confirmed.
  await writeConfig(serverDir, cfg, remainingStacks)
  if (shouldDrop) {
    // #236: preserves comments/blank lines/order for every OTHER line —
    // only candidateKeys' own lines are removed.
    await writeEnvFilePreservingFormat(envPath, [], new Set(candidateKeys))
    result.droppedKeys = candidateKeys
    result.keptOwnKeys = []
  }

  await reencryptAfterWrite(cwd)

  const droppedWord = result.droppedKeys.length === 1 ? "value" : "values"
  console.log(
    `removed ${resolvedName} from ${serverName}: ${result.droppedKeys.length} env ${droppedWord} dropped`,
  )

  return result
}

/** Write config.json with `stacks` replaced by `remainingStacks`, preserving any other field. */
async function writeConfig(
  serverDir: string,
  cfg: { stacks: { name: string }[] },
  remainingStacks: { name: string }[],
): Promise<void> {
  await Deno.writeTextFile(
    join(serverDir, "config.json"),
    JSON.stringify({ ...cfg, stacks: remainingStacks }, null, 2) + "\n",
  )
}
