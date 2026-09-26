// `rostok stack remove` — the subcommand (#225).

import { Command } from "@cliffy/command"
import { join } from "@std/path"
import { stackRemove, type StackRemoveResult } from "../stack-remove.ts"
import { readEnvFile } from "../env-files.ts"
import { normalizeRemotePath, serverDirFor } from "../server-keys.ts"
import { expandEnvRefs, resolvePathApps } from "../deploy/env.ts"
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
 * at all). Both paths are resolved the way deploy resolves them
 * (`nextStepPaths`); when either can't be resolved, the message falls
 * back to naming the variable instead of a path, since printing a stale
 * or empty value would be worse than saying nothing.
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

  const { pathApps, volumesPath } = await nextStepPaths(cwd, options.server)

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
        } set, or can't be resolved, in ${options.server}'s .env or .env.root; \`rostok deploy ${options.server} ` +
        `${result.stackName}\` does not remove it.)`,
    )
  }
  return result
}

/**
 * PATH_APPS and VOLUMES_PATH as deploy would use them (#249): `.env.root`
 * merged with the server's `.env` (server wins), PATH_APPS falling back
 * to deploy's default, `${VAR}` references expanded with deploy's own
 * `expandEnvRefs`, and the result normalised (no trailing or doubled
 * slash). A value that deploy itself would refuse to expand is returned
 * as undefined rather than printed half-resolved.
 */
async function nextStepPaths(
  cwd: string,
  server: string,
): Promise<{ pathApps?: string; volumesPath?: string }> {
  const env: Record<string, string> = {}
  // Later entries win, so the server's own .env overrides .env.root.
  for (const path of [join(cwd, ".env.root"), join(serverDirFor(cwd, server), ".env")]) {
    for (const { key, value } of await readEnvFile(path)) env[key] = value
  }
  const resolve = (key: string, value: string | undefined): string | undefined => {
    if (!value) return undefined
    try {
      return normalizeRemotePath(expandEnvRefs(key, value, env))
    } catch {
      return undefined
    }
  }
  const pathApps = resolve("PATH_APPS", resolvePathApps(env).value)
  // VOLUMES_PATH may reference PATH_APPS: expand against its final value,
  // the same order resolveDeployEnv uses.
  if (pathApps) env.PATH_APPS = pathApps
  const volumesPath = resolve("VOLUMES_PATH", env.VOLUMES_PATH)
  return { pathApps, volumesPath }
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
