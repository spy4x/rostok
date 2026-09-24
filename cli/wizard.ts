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
import type { CatalogEntry } from "./catalog.ts"
import { stackAdd, type StackAddResult } from "./stack-add.ts"
import { resolveCatalog } from "./catalog-paths.ts"
import { serverDirFor, validateServerName } from "./server-keys.ts"
import { buildNextSteps } from "./next-steps.ts"
import { type ConfirmFn, type PromptFn } from "./prompts.ts"
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
  /** Test injection point for every interactive variable prompt — see prompts.ts's PromptFn. */
  promptFn?: PromptFn
  /** Test injection point for stack-add's "add this required stack now?" yes/no prompt. */
  confirmFn?: ConfirmFn
  /** Test injection point for the multi-select stack picker. Defaults to a real Checkbox.prompt. */
  pickStacksFn?: (options: { name: string; value: string }[]) => Promise<string[]>
  /** Test injection point for the "generate an encryption key?" offer. Defaults to {@link maybeOfferKeyGeneration}. */
  offerKeyGeneration?: (cwd: string) => Promise<void>
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
  const offerKeyGeneration = opts.offerKeyGeneration ?? maybeOfferKeyGeneration
  if (init.shouldOfferKeyGeneration && !opts.nonInteractive) {
    await offerKeyGeneration(cwd)
  }

  // Step 2: server create.
  const server = await serverCreate({
    cwd,
    serverInputs: opts.serverInputs,
    providedVars: opts.providedVars,
    failFast: opts.nonInteractive,
    promptFn: opts.promptFn,
  })
  console.log(`Server '${server.serverName}' created at ${server.serverDir}`)

  // Step 3: stack add (optional).
  //
  // Interactive mode offers a multi-select (#212 — one stack per wizard
  // run was the old behavior; a hobbyist setting up traefik + a web
  // stack had to re-run the wizard just to add the second one). Non-
  // interactive mode only adds stacks named via repeatable `--stack
  // <name>`; with none given, it says so instead of failing silently
  // (#209).
  //
  // `orderStacksByRequires` (review fix) runs the batch through
  // requires-order first: when traefik and librespeed are BOTH chosen
  // in the same run, traefik is added first so librespeed's own
  // requires check finds it already on the server and never asks —
  // each `stackAdd` call still handles requires on its own (#212 point
  // 1) for anything NOT in this run's batch.
  const stackAdds: StackAddResult[] = []
  const declinedRequires: string[] = []
  if (!opts.skipStackAdd) {
    const catalog = await resolveCatalog(opts.catalogDir)
    let toAdd: string[] = []
    if (opts.nonInteractive) {
      if (opts.stacks && opts.stacks.length > 0) {
        toAdd = orderStacksByRequires(catalog, opts.stacks)
      } else {
        console.log(
          `skipped the stack step: run rostok stack add <name> -s ${server.serverName}`,
        )
      }
    } else {
      const chosen = await pickStacksInteractive(catalog, opts.pickStacksFn)
      toAdd = orderStacksByRequires(catalog, chosen)
    }
    for (const name of toAdd) {
      const result = await stackAdd(name, server.serverName, {
        cwd,
        catalogDir: opts.catalogDir,
        providedVars: opts.providedVars,
        nonInteractive: !!opts.nonInteractive,
        promptFn: opts.promptFn,
        confirmFn: opts.confirmFn,
      })
      stackAdds.push(result)
      declinedRequires.push(...result.declinedRequires)
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

/**
 * Reorder `chosen` (a batch of stack names picked in one wizard run) so
 * that any stack another chosen stack `requires` is added first —
 * within this batch only. A `requires` name NOT in `chosen` is left for
 * `stackAdd`'s own per-call requires resolution (#212 point 1), which
 * IS recursive (see stack-meta.ts) — a chain longer than one hop still
 * resolves correctly there. This function only needs one pass over
 * direct requirements because it's solving a narrower problem: ordering
 * a flat, already-known batch so nothing in it gets asked about a
 * dependency that's ALSO in the same batch — not resolving a graph.
 */
function orderStacksByRequires(catalog: CatalogEntry[], chosen: string[]): string[] {
  const chosenSet = new Set(chosen)
  const requiresWithinBatch = (name: string): string[] =>
    (catalog.find((e) => e.name === name)?.meta.requires ?? []).filter((r) => chosenSet.has(r))

  const result: string[] = []
  const remaining = [...chosen]
  let progressed = true
  while (remaining.length > 0 && progressed) {
    progressed = false
    for (let i = 0; i < remaining.length; i++) {
      const name = remaining[i]
      if (requiresWithinBatch(name).every((r) => result.includes(r))) {
        result.push(name)
        remaining.splice(i, 1)
        progressed = true
        break
      }
    }
  }
  // A leftover here means a requires cycle within the batch itself —
  // stackAdd's own cycle guard reports that clearly; just preserve the
  // original order for whatever didn't resolve rather than dropping it.
  result.push(...remaining)
  return result
}

/**
 * Interactive multi-select stack picker, showing each stack's own
 * description next to its name so a hobbyist isn't picking blind.
 * Returns an empty array if the user picks none.
 */
async function pickStacksInteractive(
  catalog: CatalogEntry[],
  pickStacksFn?: (options: { name: string; value: string }[]) => Promise<string[]>,
): Promise<string[]> {
  if (catalog.length === 0) {
    console.log("No stacks found in catalog. Skipping stack add.")
    return []
  }
  const options = catalog.map((e) => ({
    name: `${e.name} — ${e.meta.description}`,
    value: e.name,
  }))
  const pick = pickStacksFn ?? ((opts) =>
    Checkbox.prompt({
      // cliffy's Checkbox defaults to `confirmSubmit: true` (its own
      // default, not set here) — the first Enter arms submission and
      // shows its own "press enter again" hint, the second Enter
      // actually submits. "enter to confirm" undersold that: a
      // hobbyist pressing Enter once and seeing nothing happen would
      // reasonably think the prompt was stuck.
      message: "Pick stacks to add (space to select, enter twice to confirm; none to skip):",
      options: opts,
    }))
  return await pick(options)
}
