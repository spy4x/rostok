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
import { type CatalogEntry, findStack } from "../catalog.ts"
import { resolveCatalog } from "../catalog-paths.ts"
import { UserError } from "../errors.ts"
import { normalizeVariableSpec } from "../stack-meta.ts"
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
  await refuseUndeclaredVars(name, providedVars, catalogDir)
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

/**
 * #425: a --var key that neither the stack nor a stack it requires
 * declares would be dropped without a word, so a typo looks like it
 * worked. Refuse it before anything is written, naming the key and the
 * keys that are declared.
 */
async function refuseUndeclaredVars(
  name: string,
  providedVars: Record<string, string>,
  catalogDir: string | undefined,
): Promise<void> {
  if (Object.keys(providedVars).length === 0) return
  const catalog = await resolveCatalog(catalogDir)
  const declared = declaredKeys(catalog, findStack(catalog, name))
  const unknown = Object.keys(providedVars).filter((key) => !declared.includes(key))
  if (unknown.length === 0) return
  const keyWord = unknown.length === 1 ? "key" : "keys"
  throw new UserError(
    `stack '${name}' has no variable for --var ${keyWord} ${unknown.join(", ")}. ` +
      `It declares: ${declared.join(", ") || "(none)"}`,
  )
}

/** Variable keys of `entry` and of every stack it requires, directly or not, in that order. */
function declaredKeys(catalog: CatalogEntry[], entry: CatalogEntry): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  const visit = (stack: CatalogEntry) => {
    if (seen.has(stack.name)) return
    seen.add(stack.name)
    for (const spec of stack.meta.variables) {
      const key = normalizeVariableSpec(spec).key
      if (!keys.includes(key)) keys.push(key)
    }
    for (const required of stack.meta.requires ?? []) {
      const dependency = catalog.find((e) => e.name === required || e.meta.name === required)
      // An unknown dependency fails in stackAdd with its own message.
      if (dependency) visit(dependency)
    }
  }
  visit(entry)
  return keys
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
    "--var <kv:string>",
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
        --var TRAEFIK_DOMAIN=proxy.example.com \\
        --var TRAEFIK_BASIC_AUTH_USER=admin              # pre-supply variables

A --var key that the stack (or a stack it requires) does not declare is
refused, so a typo never passes silently.`,
  )
  .action(async (options, name: string) => {
    await runStackAdd(name, options)
  })
