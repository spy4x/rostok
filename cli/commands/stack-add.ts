// `rostok stack add` — the subcommand.
//
// Moved out of cli/+main.ts (review leftover from #227) so the actual
// "add a stack, then print next steps" flow is a plain exported
// function tests can call directly, with confirmFn/promptFn injected —
// same reasoning as cli/commands/deploy.ts's validateDeployArgs. Before
// this, only the pure `buildNextSteps` half was tested
// (cli/next-steps.test.ts); nothing proved that a declined `requires`
// dependency actually reaches the real CLI's own next-steps output.

import { Command } from "@cliffy/command"
import { join, relative } from "@std/path"
import { parseVarFlags } from "../cli-flags.ts"
import { stackAdd, type StackAddResult } from "../stack-add.ts"
import { serverDirFor } from "../server-keys.ts"
import { buildNextSteps } from "../next-steps.ts"
import type { ConfirmFn, PromptFn } from "../prompts.ts"

export interface StackAddCommandOptions {
  server: string
  catalog?: string
  nonInteractive?: boolean
  var?: unknown
}

/** Test injection points, bypassing cliffy entirely. */
export interface StackAddCommandOverrides {
  confirmFn?: ConfirmFn
  promptFn?: PromptFn
}

/**
 * Add `name` to `options.server`, then print the same "Next steps" block
 * `stackAdd` always ended with (#212) — including a declined `requires`
 * dependency's own `rostok stack add <dep> -s <server>` suggestion.
 */
export async function runStackAdd(
  name: string,
  options: StackAddCommandOptions,
  cwd: string = Deno.cwd(),
  overrides: StackAddCommandOverrides = {},
): Promise<StackAddResult> {
  const catalogDir = options.catalog ?? undefined
  const providedVars = parseVarFlags(options.var)
  const result = await stackAdd(name, options.server, {
    cwd,
    catalogDir,
    providedVars,
    nonInteractive: options.nonInteractive,
    confirmFn: overrides.confirmFn,
    promptFn: overrides.promptFn,
  })
  // #212: what was written and what to run next — a bare "added X to Y"
  // summary left a first-timer with no idea what came after.
  const serverDir = serverDirFor(cwd, options.server)
  const lines = await buildNextSteps({
    serverName: options.server,
    serverDir,
    written: [
      relative(cwd, join(serverDir, ".env")),
      relative(cwd, join(serverDir, "config.json")),
    ],
    missingRequires: result.declinedRequires,
  })
  console.log("")
  for (const line of lines) console.log(line)
  return result
}

export const stackAddCommand = new Command()
  .arguments("<name:string>")
  .option("-s, --server <name:string>", "target server", { required: true })
  .option("-n, --non-interactive", "skip prompts, use defaults")
  .option(
    "--catalog <dir:string>",
    "override bundled catalog directory (must exist; its stacks run as code)",
  )
  .option(
    "--var <kv...:string[]>",
    "repeatable; overrides one variable (KEY=VAL)",
    { collect: true },
  )
  .description(
    `Add a stack to a server (resolves variables, writes .env, encrypts).

A value already in servers/<server>/.env is kept unless you pass --var
for that key — re-running never clobbers another stack's key or
rotates an existing secret.

Examples:

    rostok stack add traefik -s home                    # interactive
    rostok stack add traefik -s home -n                 # non-interactive, defaults only
    rostok stack add traefik -s home \\
        --var DOMAIN=example.com \\
        --var TRAEFIK_BASIC_AUTH_USER=admin              # pre-supply variables`,
  )
  .action(async (options, name: string) => {
    await runStackAdd(name, options)
  })
