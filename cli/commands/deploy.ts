// `rostok deploy <server> [stack]` — thin wrapper over `deno task deploy`.
//
// Phase 7. The actual deploy logic lives in scripts/deploy/+main.ts (already
// powers `deno task deploy`). This wrapper:
//   1. Validates the server exists (servers/<server>/.env + config.json)
//   2. If [stack] is given, validates it's listed in config.json
//   3. Shells out to `deno task deploy <server> [stack]`
//
// Pre-flight checks give the user a clear error message instead of the
// raw deploy script's "SSH_ADDRESS must be set" confusion.

import { Command } from "@cliffy/command"
import { join } from "@std/path"

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
  const serverDir = join(cwd, "servers", server)
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
    `Deploy a server (or one of its stacks) — thin wrapper over \`deno task deploy\`.

Pre-flights servers/<server>/ + config.json so missing config produces a
clear error before the underlying deploy script runs.

Examples:

    rostok deploy home                 # deploy everything for home
    rostok deploy home traefik         # deploy only the traefik stack`,
  )
  .arguments("<server:string> [stack:string]")
  .action(async (_options, server: string, stack?: string) => {
    const cwd = Deno.cwd()
    const result = await validateDeployArgs(cwd, server, stack)
    if (!result.ok) {
      console.error(`rostok deploy: ${result.error}`)
      Deno.exit(1)
    }
    // Hand off to the existing deploy task. Pass stdout/stderr through
    // so the user sees the actual deploy output live.
    const args = ["task", "deploy", server, ...(stack ? [stack] : [])]
    const cmd = new Deno.Command(Deno.execPath(), {
      args,
      cwd,
      stdout: "inherit",
      stderr: "inherit",
    })
    const out = await cmd.output()
    Deno.exit(out.success ? 0 : (out.code ?? 1))
  })
