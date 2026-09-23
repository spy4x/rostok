// `rostok deploy <server> [stack]` — deploys in-process (#203).
//
// Runs the deploy logic (cli/deploy/run-deploy.ts) directly instead of
// shelling out to `deno task deploy` — that task doesn't exist in a
// project scaffolded by the published CLI (#203), and `scripts/` isn't
// shipped in the JSR package anyway. `validateDeployArgs`:
//   1. Validates the server name (#208 — before any file is read).
//   2. Validates the server exists (servers/<server>/.env + config.json).
//   3. If [stack] is given, validates it's listed in config.json.
//
// Pre-flight checks give the user a clear error message instead of the
// raw deploy failure's "SSH_ADDRESS must be set" confusion.

import { Command } from "@cliffy/command"
import { join } from "@std/path"
import { serverDirFor } from "../server-keys.ts"
import { UserError } from "../errors.ts"
import { runDeploy } from "../deploy/run-deploy.ts"

export interface DeployValidateResult {
  ok: boolean
  error?: string
  /** Stacks listed in config.json (empty if ok=false). */
  availableStacks?: string[]
}

/**
 * Pre-flight check for `rostok deploy`. Pure: reads files, returns
 * a result the caller decides what to do with.
 */
export async function validateDeployArgs(
  cwd: string,
  server: string,
  stack: string | undefined,
): Promise<DeployValidateResult> {
  // #208: validate the server name before touching the filesystem.
  let serverDir: string
  try {
    serverDir = serverDirFor(cwd, server)
  } catch (err) {
    if (err instanceof UserError) return { ok: false, error: err.message }
    throw err
  }
  const envPath = join(serverDir, ".env")
  const configPath = join(serverDir, "config.json")

  // 1. servers/<server>/ must exist with .env.
  try {
    await Deno.stat(envPath)
  } catch {
    return {
      ok: false,
      error: `server '${server}' not found at ${envPath}.\n` +
        `  run \`rostok server create ${server}\` first.`,
    }
  }

  // 2. config.json must exist (no stacks configured → nothing to deploy).
  let configText: string
  try {
    configText = await Deno.readTextFile(configPath)
  } catch {
    return {
      ok: false,
      error: `${configPath} missing — no stacks configured for '${server}'.\n` +
        `  run \`rostok stack add <name> -s ${server}\` first.`,
    }
  }

  // 3. If stack arg given, verify it's listed.
  let config: { stacks?: { name: string }[] } = {}
  try {
    config = JSON.parse(configText)
  } catch (err) {
    return {
      ok: false,
      error: `${configPath} is not valid JSON: ${err instanceof Error ? err.message : err}`,
    }
  }
  const availableStacks = (config.stacks ?? []).map((s) => s.name)
  if (availableStacks.length === 0) {
    return {
      ok: false,
      error: `server '${server}' has no stacks in config.json.\n` +
        `  run \`rostok stack add <name> -s ${server}\` first.`,
      availableStacks,
    }
  }
  if (stack !== undefined && !availableStacks.includes(stack)) {
    return {
      ok: false,
      error: `stack '${stack}' not found in server '${server}' config.json.\n` +
        `  available: ${availableStacks.join(", ")}`,
      availableStacks,
    }
  }

  return { ok: true, availableStacks }
}

/** `rostok deploy <server> [stack]` — the subcommand. */
export const deployCommand = new Command()
  .description(
    `Deploy a server (or one of its stacks) — rsyncs its files and runs
docker compose on the remote host.

Pre-flights servers/<server>/ + config.json so missing config produces a
clear error before the deploy runs.

Examples:

    rostok deploy home                 # deploy everything for home
    rostok deploy home traefik         # deploy only the traefik stack`,
  )
  .arguments("<server:string> [stack:string]")
  .action(async (_options, server: string, stack?: string) => {
    // #211: throw UserError for every expected failure instead of
    // printing and calling Deno.exit here — cli/+main.ts's top-level
    // handler is the one place that formats a UserError as
    // `rostok: <message>` with no stack trace. Letting it propagate
    // (rather than catching and exiting inline) is what lets that
    // wrapper own the formatting.
    const cwd = Deno.cwd()
    const result = await validateDeployArgs(cwd, server, stack)
    if (!result.ok) {
      throw new UserError(result.error!)
    }
    await runDeploy({ cwd, server, stack })
  })
