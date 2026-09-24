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

import { join } from "@std/path"
import { encryptEnvFiles } from "./encrypt.ts"
import { type EnvEntry, readEnvFile, writeEnvFile } from "./env-files.ts"
import { type CatalogEntry, findStack } from "./catalog.ts"
import { resolveCatalog } from "./catalog-paths.ts"
import { normalizeVariableSpec } from "./stack-meta.ts"
import { type ConfirmFn, defaultConfirmFn } from "./prompts.ts"
import { isServerKey, serverDirFor } from "./server-keys.ts"
import { readServerConfig } from "./stack-add.ts"
import { UserError } from "./errors.ts"

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
}

/**
 * Remove a stack from a server: drops it from `config.json`, and — on
 * confirmation, `--drop-env`, or never in non-interactive mode without
 * that flag — its own env keys from `.env`. Re-encrypts afterward, same
 * as `stackAdd`.
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
    throw new UserError(`server "${serverName}" not found: run rostok server create ${serverName}`)
  }

  const catalog = await resolveCatalog(opts.catalogDir)
  const entry = findStack(catalog, stackName)

  const cfg = await readServerConfig(serverDir)
  if (!cfg.stacks.some((s) => s.name === entry.meta.name)) {
    throw new UserError(`stack '${entry.meta.name}' is not installed on '${serverName}'`)
  }

  // #225 — refuse when another still-installed stack `requires` this
  // one, naming the dependent(s), unless --force. A dependent whose own
  // `+meta.ts` can't be resolved (removed from a `--catalog` override
  // between installs) is skipped rather than crashing the removal —
  // there's nothing to name it by anyway.
  const dependents: string[] = []
  for (const installed of cfg.stacks) {
    if (installed.name === entry.meta.name) continue
    let depEntry: CatalogEntry
    try {
      depEntry = findStack(catalog, installed.name)
    } catch {
      continue
    }
    if ((depEntry.meta.requires ?? []).includes(entry.meta.name)) {
      dependents.push(installed.name)
    }
  }
  if (dependents.length > 0 && !opts.force) {
    throw new UserError(
      `can't remove '${entry.meta.name}': required by ${
        dependents.join(", ")
      } — pass --force to remove anyway.`,
    )
  }

  // Drop the stack from config.json first — this is unconditional; only
  // the .env cleanup below is optional/confirmed.
  const remainingStacks = cfg.stacks.filter((s) => s.name !== entry.meta.name)
  await Deno.writeTextFile(
    join(serverDir, "config.json"),
    JSON.stringify({ ...cfg, stacks: remainingStacks }, null, 2) + "\n",
  )

  // Candidate keys: only what THIS stack's own +meta.ts declares (never
  // "anything with a matching prefix" — see module comment), minus any
  // server-level key, minus anything another still-installed stack also
  // declares (#210 says this can't happen; checked anyway per #225).
  const ownDeclaredKeys = new Set(
    entry.meta.variables.map((v) => normalizeVariableSpec(v).key),
  )
  const otherDeclaredKeys = new Set<string>()
  for (const installed of remainingStacks) {
    let otherEntry: CatalogEntry
    try {
      otherEntry = findStack(catalog, installed.name)
    } catch {
      continue
    }
    for (const v of otherEntry.meta.variables) {
      otherDeclaredKeys.add(normalizeVariableSpec(v).key)
    }
  }

  const existing = await readEnvFile(envPath)
  const candidateKeys = existing
    .map((e) => e.key)
    .filter((key) => ownDeclaredKeys.has(key) && !isServerKey(key) && !otherDeclaredKeys.has(key))

  const result: StackRemoveResult = {
    stackName: entry.meta.name,
    serverName,
    droppedKeys: [],
    keptOwnKeys: [...candidateKeys],
  }

  if (candidateKeys.length === 0) {
    await encryptEnvFiles(cwd)
    console.log(`removed ${entry.meta.name} from ${serverName}`)
    return result
  }

  let shouldDrop = false
  if (opts.dropEnv) {
    shouldDrop = true
  } else if (opts.nonInteractive) {
    console.log(
      `rostok: kept ${candidateKeys.length} ${
        candidateKeys.length === 1 ? "value" : "values"
      } for ${entry.meta.name} in ${serverName}/.env (${
        candidateKeys.join(", ")
      }) — pass --drop-env to remove them, or run interactively.`,
    )
  } else {
    const confirmFn = opts.confirmFn ?? defaultConfirmFn
    shouldDrop = await confirmFn({
      message: `Also remove ${entry.meta.name}'s own values from ${serverName}/.env (${
        candidateKeys.join(", ")
      })?`,
      default: false,
    })
    if (!shouldDrop) {
      console.log(
        `rostok: kept ${entry.meta.name}'s values in ${serverName}/.env — remove them later ` +
          `by hand, or re-run \`rostok stack remove ${entry.meta.name} -s ${serverName} --drop-env\`.`,
      )
    }
  }

  if (shouldDrop) {
    const updated = existing.filter((e: EnvEntry) => !candidateKeys.includes(e.key))
    await writeEnvFile(envPath, updated)
    result.droppedKeys = candidateKeys
    result.keptOwnKeys = []
  }

  await encryptEnvFiles(cwd)

  const droppedWord = result.droppedKeys.length === 1 ? "value" : "values"
  console.log(
    `removed ${entry.meta.name} from ${serverName}: ${result.droppedKeys.length} env ${droppedWord} dropped`,
  )

  return result
}
