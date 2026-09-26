// `rostok stack remove` — the subcommand (#225).

import { Command } from "@cliffy/command"
import { join } from "@std/path"
import { stackRemove, type StackRemoveResult } from "../stack-remove.ts"
import { readEnvFile } from "../env-files.ts"
import {
  normalizeRemotePath,
  pathsNestedOrEqual,
  serverDirFor,
  validateRemotePath,
} from "../server-keys.ts"
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

  const paths = await nextStepPaths(cwd, options.server)

  console.log("")
  console.log("Next steps:")
  console.log(`  rostok deploy ${options.server}`)
  if (paths.ok) {
    const stackDir = `${paths.pathApps}/stacks/${result.stackName}`
    console.log(
      `  (stops ${result.stackName}, removes ${stackDir} and keeps everything under ` +
        `${paths.volumesPath}; \`rostok deploy ${options.server} ` +
        `${result.stackName}\` does not remove it.)`,
    )
  } else {
    const reasons: string[] = []
    if (paths.missing.length > 0) {
      reasons.push(
        `${paths.missing.join(" and ")} ${paths.missing.length > 1 ? "aren't" : "isn't"} set`,
      )
    }
    if (paths.invalid.length > 0) {
      reasons.push(
        `${paths.invalid.join(" and ")} ${paths.invalid.length > 1 ? "are" : "is"} invalid`,
      )
    }
    const refusal = paths.invalid.length > 0
      ? `, so deploy would refuse ${paths.invalid.length > 1 ? "them" : "it"}`
      : ""
    console.log(
      `  (stops ${result.stackName}, removes its directory and keeps its data — the exact ` +
        `paths aren't shown because ${reasons.join(" and ")} in ${options.server}'s .env ` +
        `or .env.root${refusal}; \`rostok deploy ${options.server} ` +
        `${result.stackName}\` does not remove it.)`,
    )
  }
  return result
}

/** Next-step paths deploy would use, or which keys stop them from being shown. */
type NextStepPaths =
  | { ok: true; pathApps: string; volumesPath: string }
  | { ok: false; missing: string[]; invalid: string[] }

/**
 * PATH_APPS and VOLUMES_PATH as deploy would use them (#249), in
 * resolveDeployEnv's own order: `.env.root` merged with the server
 * `.env` (server wins), PATH_APPS falling back to deploy's default,
 * PATH_APPS expanded first and VOLUMES_PATH expanded against that
 * (not yet normalised) value, both checked with validateRemotePath,
 * then normalised and checked for nesting. A key deploy would refuse is
 * reported as invalid and never printed; VOLUMES_PATH missing from both
 * files is reported as not set.
 */
async function nextStepPaths(cwd: string, server: string): Promise<NextStepPaths> {
  const env: Record<string, string> = {}
  // Later entries win, so the server's own .env overrides .env.root.
  for (const path of [join(cwd, ".env.root"), join(serverDirFor(cwd, server), ".env")]) {
    for (const { key, value } of await readEnvFile(path)) env[key] = value
  }
  const missing: string[] = []
  const invalid: string[] = []

  let pathApps: string | undefined
  try {
    pathApps = expandEnvRefs("PATH_APPS", resolvePathApps(env).value, env)
    validateRemotePath("PATH_APPS", pathApps)
  } catch {
    pathApps = undefined
    invalid.push("PATH_APPS")
  }

  let volumesPath: string | undefined
  if (!env.VOLUMES_PATH) {
    missing.push("VOLUMES_PATH")
  } else {
    try {
      const expandEnv = pathApps === undefined ? env : { ...env, PATH_APPS: pathApps }
      volumesPath = expandEnvRefs("VOLUMES_PATH", env.VOLUMES_PATH, expandEnv)
      validateRemotePath("VOLUMES_PATH", volumesPath, 1)
    } catch {
      volumesPath = undefined
      invalid.push("VOLUMES_PATH")
    }
  }

  if (pathApps === undefined || volumesPath === undefined) {
    return { ok: false, missing, invalid }
  }
  pathApps = normalizeRemotePath(pathApps)
  volumesPath = normalizeRemotePath(volumesPath)
  if (pathsNestedOrEqual(pathApps, volumesPath)) {
    return { ok: false, missing, invalid: ["PATH_APPS", "VOLUMES_PATH"] }
  }
  return { ok: true, pathApps, volumesPath }
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
