// Wizard orchestrator — the default `$ rostok` action.
//
// Per docs/v1-cli.md §3.1, the no-args command runs three steps in
// sequence:
//
//   1. Init  — idempotent project skeleton (deno.jsonc, .gitignore, servers/, .env.root)
//   2. Server create — interactive prompts for the server-level vars
//   3. Stack add — pick one stack from the bundled catalog, run its variable flow
//
// The wizard is interactive by default. `-n` / `--non-interactive` uses
// defaults + any `--var KEY=VAL` overrides; fails fast on missing
// inputs (per docs/v1-cli.md §3.4 strict-default policy).

import { Select } from "@cliffy/prompt"
import { initProject, type InitResult } from "./init.ts"
import { serverCreate, type ServerCreateInput } from "./server-create.ts"
import { stackAdd, type StackAddResult } from "./stack-add.ts"
import { loadCatalog } from "./catalog.ts"
import { defaultCatalogDir } from "./catalog-paths.ts"

export interface WizardOptions {
  cwd?: string
  catalogDir?: string
  nonInteractive?: boolean
  serverInputs?: Partial<ServerCreateInput>
  providedVars?: Record<string, string>
  /** Skip stack add entirely (used by `server create` subcommand). */
  skipStackAdd?: boolean
}

export interface WizardResult {
  init: InitResult
  serverName: string
  stackAdd?: StackAddResult
}

/**
 * Run the full wizard flow. Phase 5 ships the interactive happy path;
 * non-interactive mode is a thin shell that fails loudly on missing
 * inputs (no silent fallbacks).
 */
export async function runWizard(opts: WizardOptions = {}): Promise<WizardResult> {
  const cwd = opts.cwd ?? Deno.cwd()

  // Step 1: init.
  const init = await initProject(cwd)
  if (init.created.length > 0) {
    console.log("Initialized:")
    for (const f of init.created) console.log(`  + ${f}`)
  }
  if (init.skipped.length > 0 && !opts.nonInteractive) {
    for (const f of init.skipped) console.log(`  = ${f} (already exists, left alone)`)
  }

  // Step 2: server create.
  //
  // --var KEY=VAL flags apply to BOTH server-create inputs and stack
  // variables: callers expect `rostok --var serverName=foo --var DOMAIN=...`
  // to feed both layers. server-create's `nonInteractive` accepts a
  // Partial<ServerCreateInput>; we merge providedVars into it so flag
  // values reach collectInput. Explicit serverInputs still win on key
  // collision (programmatic callers shouldn't be overridden by --var).
  const server = await serverCreate({
    cwd,
    nonInteractive: { ...opts.providedVars, ...opts.serverInputs },
    failFast: opts.nonInteractive,
  })
  console.log(`Server '${server.serverName}' created at ${server.serverDir}`)

  // Step 3: stack add (optional). In non-interactive mode without
  // --stacks=, skip — caller can run `rostok stack add <name> -s <server>`
  // explicitly. In interactive mode, prompt for a stack.
  let stackAddResult: StackAddResult | undefined
  if (!opts.skipStackAdd) {
    const catalogDir = opts.catalogDir ?? defaultCatalogDir(cwd)
    const catalog = await loadCatalog(catalogDir)

    let chosen: string | undefined
    if (opts.nonInteractive) {
      // Phase 5 non-interactive mode: skip stack add. Phase 5b adds
      // `--stacks=<csv>` bulk-add.
    } else {
      chosen = await pickStackInteractive(catalog.map((e) => e.meta.name))
      if (chosen) {
        stackAddResult = await stackAdd(chosen, server.serverName, {
          cwd,
          catalogDir,
          providedVars: opts.providedVars,
          nonInteractive: opts.nonInteractive,
        })
        console.log(
          `Stack '${chosen}' added to '${server.serverName}'. ` +
            `${stackAddResult.writtenEntries.length} vars written, ` +
            `${stackAddResult.skippedKeys.length} skipped.`,
        )
      }
    }
  }

  return { init, serverName: server.serverName, stackAdd: stackAddResult }
}

/** Interactive single-stack picker. Returns undefined if user picks — skip —. */
async function pickStackInteractive(stackNames: string[]): Promise<string | undefined> {
  if (stackNames.length === 0) {
    console.log("No stacks found in catalog. Skipping stack add.")
    return undefined
  }
  const SKIP = "__skip__"
  const picked = await Select.prompt({
    message: "Pick a stack to add (or skip):",
    options: [
      { name: "— skip —", value: SKIP },
      ...stackNames.map((name) => ({ name, value: name })),
    ],
  })
  return picked === SKIP ? undefined : picked
}
