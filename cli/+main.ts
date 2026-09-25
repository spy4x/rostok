// rostok CLI root entry.
//
// Phase 5: wire the wizard as the default action, replace server/stack
// subcommand stubs with real flows. Phase 9: polish help text + add
// examples per subcommand (cliffy renders the multi-line description
// verbatim in --help output).

import { Command, ValidationError } from "@cliffy/command"
import { DESCRIPTION, NAME, VERSION } from "./version.ts"
import { UserError } from "./errors.ts"
import { stripControlChars } from "./deploy/exec.ts"
import { SERVER_VAR_ALIASES, SERVER_VAR_KEYS, serverCreate } from "./server-create.ts"
import { parseStackFlags, parseVarFlags } from "./cli-flags.ts"
import { deployCommand } from "./commands/deploy.ts"
import { envCommand } from "./commands/env.ts"
import { stackListCommand } from "./commands/list.ts"
import { stackAddCommand } from "./commands/stack-add.ts"
import { stackRemoveCommand } from "./commands/stack-remove.ts"
// Side-effect import: keep arktype + StackMeta + defaults reachable through
// the public barrel. The CLI entry is the canonical "load the package"
// location.
import "./+lib.ts"

// #209: --help lists the --var keys server-create/the wizard accept, so
// non-interactive mode is discoverable without reading the source.
const SERVER_VAR_HELP = `Server --var keys: ${SERVER_VAR_KEYS.join(", ")}
  (legacy aliases: ${SERVER_VAR_ALIASES.join(", ")})`

const ROOT_DESCRIPTION = `${DESCRIPTION}

Run \`rostok\` for the full onboarding wizard (init + server create + stack
add). Use the subcommands below for finer control.

${SERVER_VAR_HELP}

Examples:

    rostok                                # full wizard, interactive
    rostok -n --var SERVER_NAME=home --var SSH_ADDRESS=root@192.0.2.1 \\
        --var DOMAIN=example.com --var CONTACT_EMAIL=a@example.com
                                           # full wizard, non-interactive
    rostok server create home             # create one server, standalone
    rostok stack add traefik -s home      # add a stack to a server
    rostok stack remove traefik -s home   # remove a stack from a server
    rostok stack list --tree              # browse the bundled catalog
    rostok deploy home                    # deploy (wraps deno task deploy)
    rostok env status                     # encryption posture + next steps`

// deno-lint-ignore no-explicit-any
export function buildCommand(): any {
  const cmd = new Command()
    .name(NAME)
    .version(VERSION)
    // #211: cliffy's default behavior prints its own error + exits from
    // inside parse() itself, before any try/catch around parse() ever
    // runs. throwErrors() makes it throw a ValidationError instead, so
    // `runCli` below can format every failure the same way.
    .throwErrors()
    .description(ROOT_DESCRIPTION)
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
    .option(
      "--stack <name...:string[]>",
      "repeatable; add this stack in non-interactive mode",
      { collect: true },
    )
    .action(async (options) => {
      const providedVars = parseVarFlags(options.var)
      const stacks = parseStackFlags(options.stack)
      const { runWizard } = await import("./wizard.ts")
      await runWizard({
        cwd: Deno.cwd(),
        catalogDir: options.catalog,
        nonInteractive: options.nonInteractive,
        providedVars,
        stacks,
      })
      console.log("")
      console.log(`${NAME} v${VERSION} — wizard complete.`)
    })

  cmd.command(
    "server",
    new Command()
      .description("Manage rostok servers.")
      .command(
        "create",
        new Command()
          .arguments("[name:string]")
          .option("-n, --non-interactive", "skip prompts, use defaults")
          .option(
            "--var <kv...:string[]>",
            "repeatable; overrides one server field (KEY=VAL)",
            { collect: true },
          )
          .description(
            `Create a new server (writes servers/<name>/.env, encrypts).

${SERVER_VAR_HELP}

Examples:

    rostok server create                  # interactive, prompts for everything
    rostok server create home             # name as positional arg
    rostok server create home -n \\
        --var SSH_ADDRESS=root@192.0.2.1 --var DOMAIN=example.com \\
        --var CONTACT_EMAIL=a@example.com # non-interactive, defaults for the rest`,
          )
          .action(async (options, name?: string) => {
            const providedVars = parseVarFlags(options.var)
            await serverCreate({
              cwd: Deno.cwd(),
              serverInputs: name ? { serverName: name } : undefined,
              providedVars,
              failFast: options.nonInteractive,
            })
          }),
      ),
  )

  cmd.command(
    "stack",
    new Command()
      .description("Manage stacks from the bundled catalog.")
      .command("add", stackAddCommand)
      .command("remove", stackRemoveCommand)
      .command(
        "list",
        stackListCommand,
      ),
  )

  cmd.command("deploy", deployCommand)

  cmd.command("env", envCommand)

  return cmd
}

/**
 * Translate a thrown error into rostok's own format (#211): a `UserError`
 * or a cliffy `ValidationError` (bad flag, missing required option —
 * cliffy throws these once `.throwErrors()` is set, instead of printing
 * its own message and exiting from inside `parse()`) becomes one
 * `rostok: <message>` line with no stack trace. Anything else is a bug:
 * it gets the message plus a one-line pointer to file an issue, and the
 * stack trace only when `debug` is true (from `ROSTOK_DEBUG=1`).
 *
 * Pure — no `console`/`Deno.exit` — so tests can check the exact lines
 * for every branch (including the debug trace) without spawning a
 * subprocess or intercepting process exit.
 *
 * `message` is stripped of control characters once, here, rather than
 * relying on every call site that builds a `UserError` to remember to
 * do it (#243 review): several thrown messages embed remote text
 * (`getent group docker` output, an SSH connection error, `readlink -f`
 * output) without going through `stripControlChars` at the point where
 * they're built. Stripping centrally, right before the message is
 * formatted for the terminal, closes every one of those gaps at once —
 * the per-call-site strips already in docker-preflight.ts stay too,
 * since stripping twice is harmless and they also protect a message
 * that never reaches this function (stale-cleanup's own console.log of
 * the remote script's stdout).
 */
export function formatCliError(err: unknown, debug: boolean): string[] {
  const message = stripControlChars(err instanceof Error ? err.message : String(err))
  if (err instanceof UserError || err instanceof ValidationError) {
    return [`rostok: ${message}`]
  }
  const lines = [
    `rostok: unexpected error: ${message}`,
    "this is a bug, please report it at https://github.com/spy4x/rostok/issues",
  ]
  if (debug && err instanceof Error && err.stack) {
    lines.push(err.stack)
  }
  return lines
}

/** Run the CLI and print+exit via {@link formatCliError} on any thrown error. */
export async function runCli(args: string[]): Promise<void> {
  try {
    await buildCommand().parse(args)
  } catch (err) {
    const lines = formatCliError(err, Deno.env.get("ROSTOK_DEBUG") === "1")
    for (const line of lines) console.error(line)
    Deno.exit(1)
  }
}

if (import.meta.main) {
  await runCli(Deno.args)
}

// Re-exported for 1.x import-site compatibility (cli/+main.test.ts and any
// external caller import these from here) — the implementation lives in
// cli-flags.ts so cli/commands/*.ts can use it without importing +main.ts.
export { parseStackFlags, parseVarFlags } from "./cli-flags.ts"
