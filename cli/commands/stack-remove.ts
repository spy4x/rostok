// `rostok stack remove` — the subcommand (#225).

import { Command } from "@cliffy/command"
import { stackRemove, type StackRemoveResult } from "../stack-remove.ts"
import type { ConfirmFn } from "../prompts.ts"

export interface StackRemoveCommandOptions {
  server: string
  catalog?: string
  nonInteractive?: boolean
  force?: boolean
  dropEnv?: boolean
}

/** Test injection point, bypassing cliffy entirely. */
export interface StackRemoveCommandOverrides {
  confirmFn?: ConfirmFn
}

/**
 * Remove `name` from `options.server`, then print what to do next.
 * `rostok deploy <server>` deletes the removed stack's directory on the
 * server (cli/deploy/run-deploy.ts's stale-stack cleanup), but it does
 * NOT stop or remove that stack's containers first — they're only
 * managed through the compose file that deploy is about to delete, so
 * they keep running, unmanaged, until stopped by hand.
 */
export async function runStackRemove(
  name: string,
  options: StackRemoveCommandOptions,
  cwd: string = Deno.cwd(),
  overrides: StackRemoveCommandOverrides = {},
): Promise<StackRemoveResult> {
  const result = await stackRemove(name, options.server, {
    cwd,
    catalogDir: options.catalog,
    nonInteractive: options.nonInteractive,
    dropEnv: options.dropEnv,
    force: options.force,
    confirmFn: overrides.confirmFn,
  })
  console.log("")
  console.log("Next steps:")
  console.log(`  rostok deploy ${options.server}`)
  console.log(
    `  (this deletes ${result.stackName}'s files on the server but does not stop its ` +
      `containers — stop them yourself first, e.g. \`docker compose down\` in its directory ` +
      `on the server, or \`docker stop\`/\`docker rm\` its hl-${result.stackName}-* containers ` +
      `afterward.)`,
  )
  return result
}

export const stackRemoveCommand = new Command()
  .arguments("<name:string>")
  .option("-s, --server <name:string>", "target server", { required: true })
  .option("-n, --non-interactive", "skip prompts; leaves env keys unless --drop-env")
  .option(
    "--catalog <dir:string>",
    "override bundled catalog directory (must exist; its stacks run as code)",
  )
  .option("--drop-env", "also remove the stack's own values from .env, without asking")
  .option("--force", "remove even though another installed stack still requires it")
  .description(
    `Remove a stack from a server (drops it from config.json, encrypts).

Refuses when another installed stack's \`requires\` still names this one,
unless --force. Its own values in servers/<server>/.env are kept unless
you confirm (interactive), pass --drop-env, or leave alone with a
printed notice (-n).

Examples:

    rostok stack remove librespeed -s home              # interactive
    rostok stack remove librespeed -s home -n           # leaves env values, prints a notice
    rostok stack remove librespeed -s home --drop-env   # also drops its own .env values
    rostok stack remove traefik -s home --force         # remove despite dependents`,
  )
  .action(async (options, name: string) => {
    await runStackRemove(name, options)
  })
