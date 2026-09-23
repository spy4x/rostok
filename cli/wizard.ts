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
import { resolveCatalog } from "./catalog-paths.ts"

export interface WizardOptions {
  cwd?: string
  catalogDir?: string
  nonInteractive?: boolean
  serverInputs?: Partial<ServerCreateInput>
  providedVars?: Record<string, string>
  /** Skip stack add entirely (used by `server create` subcommand). */
  skipStackAdd?: boolean
  /** Stacks to add non-interactively (repeatable `--stack <name>`). */
  stacks?: string[]
}

export interface WizardResult {
  init: InitResult
  serverName: string
  stackAdds: StackAddResult[]
}

/**
 * Run the full wizard flow. Ships the interactive happy path;
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
  const server = await serverCreate({
    cwd,
    serverInputs: opts.serverInputs,
    providedVars: opts.providedVars,
    failFast: opts.nonInteractive,
  })
  console.log(`Server '${server.serverName}' created at ${server.serverDir}`)

  // Step 3: stack add (optional).
  //
  // Interactive mode prompts for one stack from the catalog. Non-
  // interactive mode only adds stacks named via repeatable `--stack
  // <name>`; with none given, it says so instead of failing silently
  // (#209).
  const stackAdds: StackAddResult[] = []
  if (!opts.skipStackAdd) {
    if (opts.nonInteractive) {
      if (opts.stacks && opts.stacks.length > 0) {
        for (const name of opts.stacks) {
          stackAdds.push(
            await stackAdd(name, server.serverName, {
              cwd,
              catalogDir: opts.catalogDir,
              providedVars: opts.providedVars,
              nonInteractive: true,
            }),
          )
        }
      } else {
        console.log(
          `skipped the stack step: run rostok stack add <name> -s ${server.serverName}`,
        )
      }
    } else {
      const catalog = await resolveCatalog(opts.catalogDir)
      const chosen = await pickStackInteractive(catalog.map((e) => e.name))
      if (chosen) {
        stackAdds.push(
          await stackAdd(chosen, server.serverName, {
            cwd,
            catalogDir: opts.catalogDir,
            providedVars: opts.providedVars,
            nonInteractive: false,
          }),
        )
      }
    }
  }

  return { init, serverName: server.serverName, stackAdds }
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
