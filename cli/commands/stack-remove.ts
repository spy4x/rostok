// `rostok stack remove` — the subcommand (#225).

import { Command } from "@cliffy/command"
import { join } from "@std/path"
import { stackRemove, type StackRemoveResult } from "../stack-remove.ts"
import { readEnvFile } from "../env-files.ts"
import { serverDirFor } from "../server-keys.ts"
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
 * Since 1.2.0 (#241), `rostok deploy <server>` (a full deploy, no
 * `<stack>` argument) stops the removed stack's containers itself, via
 * its stale-stack cleanup (cli/deploy/stale-stacks.ts), then removes
 * its directory (`<PATH_APPS>/stacks/<name>`) — a single-stack deploy
 * (`rostok deploy <server> <name>`) never runs that cleanup and so
 * never removes it (run-deploy.ts). The message says its data is kept
 * under `<VOLUMES_PATH>` as a whole, never `<VOLUMES_PATH>/<name>`: a
 * stack's data doesn't always live in a folder named after the stack
 * (usememos keeps its data in `memos`, woodpecker splits into
 * `woodpecker-server`/`woodpecker-agent`, librespeed has no data folder
 * at all). Both paths are read from the server's own `.env`; when
 * either is missing, the message falls back to naming the variable
 * instead of a path, since printing a stale or empty value would be
 * worse than saying nothing.
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

  const serverDir = serverDirFor(cwd, options.server)
  const entries = await readEnvFile(join(serverDir, ".env"))
  const pathApps = entries.find((e) => e.key === "PATH_APPS")?.value
  const volumesPath = entries.find((e) => e.key === "VOLUMES_PATH")?.value

  console.log("")
  console.log("Next steps:")
  console.log(`  rostok deploy ${options.server}`)
  if (pathApps && volumesPath) {
    const stackDir = `${pathApps}/stacks/${result.stackName}`
    console.log(
      `  (stops ${result.stackName}, removes ${stackDir} and keeps everything under ` +
        `${volumesPath}; \`rostok deploy ${options.server} ` +
        `${result.stackName}\` does not remove it.)`,
    )
  } else {
    const missing = [
      pathApps ? undefined : "PATH_APPS",
      volumesPath ? undefined : "VOLUMES_PATH",
    ].filter((v): v is string => v !== undefined).join(" and ")
    console.log(
      `  (stops ${result.stackName}, removes its directory and keeps its data — the exact ` +
        `paths aren't shown because ${missing} ${
          missing.includes(" and ") ? "aren't" : "isn't"
        } set in ${options.server}'s .env; \`rostok deploy ${options.server} ` +
        `${result.stackName}\` does not remove it.)`,
    )
  }
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
