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

import { Checkbox } from "@cliffy/prompt"
import { initProject, type InitResult, maybeOfferKeyGeneration } from "./init.ts"
import { serverCreate, type ServerCreateInput } from "./server-create.ts"
import { stackAdd, type StackAddResult } from "./stack-add.ts"
import { resolveCatalog } from "./catalog-paths.ts"
import { serverDirFor, validateServerName } from "./server-keys.ts"
import { buildNextSteps } from "./next-steps.ts"
import { join, relative } from "@std/path"

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

  // #208 review fix: when the server name is already known (--var or a
  // programmatic caller's serverInputs), validate it before init writes
  // anything — a traversal name shouldn't leave a half-finished project
  // skeleton behind. server-create validates again once it's the one
  // asking (interactive mode may still need to prompt for the name).
  const knownServerName = opts.serverInputs?.serverName ?? opts.providedVars?.SERVER_NAME ??
    opts.providedVars?.serverName
  if (knownServerName !== undefined) {
    validateServerName(knownServerName)
  }

  // Step 1: init.
  const init = await initProject(cwd)
  if (init.created.length > 0) {
    console.log("Initialized:")
    for (const f of init.created) console.log(`  + ${f}`)
  }
  if (init.skipped.length > 0 && !opts.nonInteractive) {
    for (const f of init.skipped) console.log(`  = ${f} (already exists, left alone)`)
  }
  // #212: offer key generation only after the file list above is on
  // screen — the prompt used to run inside initProject, before the user
  // had any idea what "Initialized" even referred to.
  if (init.shouldOfferKeyGeneration && !opts.nonInteractive) {
    await maybeOfferKeyGeneration(cwd)
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
  // Interactive mode offers a multi-select (#212 — one stack per wizard
  // run was the old behavior; a hobbyist setting up traefik + a web
  // stack had to re-run the wizard just to add the second one). Non-
  // interactive mode only adds stacks named via repeatable `--stack
  // <name>`; with none given, it says so instead of failing silently
  // (#209). Each `stackAdd` call handles its own `requires` dependency
  // (#212 point 1), so picking e.g. only "librespeed" still ends up with
  // traefik too.
  const stackAdds: StackAddResult[] = []
  const declinedRequires: string[] = []
  if (!opts.skipStackAdd) {
    if (opts.nonInteractive) {
      if (opts.stacks && opts.stacks.length > 0) {
        for (const name of opts.stacks) {
          const result = await stackAdd(name, server.serverName, {
            cwd,
            catalogDir: opts.catalogDir,
            providedVars: opts.providedVars,
            nonInteractive: true,
          })
          stackAdds.push(result)
          declinedRequires.push(...result.declinedRequires)
        }
      } else {
        console.log(
          `skipped the stack step: run rostok stack add <name> -s ${server.serverName}`,
        )
      }
    } else {
      const catalog = await resolveCatalog(opts.catalogDir)
      const chosen = await pickStacksInteractive(catalog.map((e) => e.name))
      for (const name of chosen) {
        const result = await stackAdd(name, server.serverName, {
          cwd,
          catalogDir: opts.catalogDir,
          providedVars: opts.providedVars,
          nonInteractive: false,
        })
        stackAdds.push(result)
        declinedRequires.push(...result.declinedRequires)
      }
    }
  }

  // #212: what was written and what to run next — the old wizard ended
  // with just "wizard complete.", leaving a first-timer to guess.
  const serverDir = serverDirFor(cwd, server.serverName)
  const written = [
    relative(cwd, join(serverDir, ".env")),
    relative(cwd, join(serverDir, "config.json")),
  ]
  const nextSteps = await buildNextSteps({
    serverName: server.serverName,
    serverDir,
    written,
    missingRequires: [...new Set(declinedRequires)],
  })
  console.log("")
  for (const line of nextSteps) console.log(line)

  return { init, serverName: server.serverName, stackAdds }
}

/** Interactive multi-select stack picker. Returns an empty array if the user picks none. */
async function pickStacksInteractive(stackNames: string[]): Promise<string[]> {
  if (stackNames.length === 0) {
    console.log("No stacks found in catalog. Skipping stack add.")
    return []
  }
  return await Checkbox.prompt({
    message: "Pick stacks to add (space to select, enter to confirm; none to skip):",
    options: stackNames.map((name) => ({ name, value: name })),
  })
}
