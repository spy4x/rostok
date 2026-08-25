// rostok CLI root entry.
//
// Phase 5: wire the wizard as the default action, replace server/stack
// subcommand stubs with real flows. Phase 9: polish help text + add
// examples per subcommand (cliffy renders the multi-line description
// verbatim in --help output).

import { Command } from "@cliffy/command"
import { DESCRIPTION, NAME, VERSION } from "./version.ts"
import { serverCreate } from "./server-create.ts"
import { stackAdd } from "./stack-add.ts"
import { deployCommand } from "./commands/deploy.ts"
import { envCommand } from "./commands/env.ts"
import { stackListCommand } from "./commands/list.ts"
// Side-effect import: keep arktype + StackMeta + defaults reachable through
// the public barrel. The CLI entry is the canonical "load the package"
// location.
import "./+lib.ts"

const ROOT_DESCRIPTION = `${DESCRIPTION}

Run \`rostok\` for the full onboarding wizard (init + server create + stack
add). Use the subcommands below for finer control.

Examples:

    rostok                                # full wizard, interactive
    rostok server create home             # create one server, standalone
    rostok stack add traefik -s home      # add a stack to a server
    rostok stack list --tree              # browse the bundled catalog
    rostok deploy home                    # deploy (wraps deno task deploy)
    rostok env status                     # encryption posture + next steps`

// deno-lint-ignore no-explicit-any
export function buildCommand(): any {
  const cmd = new Command()
    .name(NAME)
    .version(VERSION)
    .description(ROOT_DESCRIPTION)
    .option("-n, --non-interactive", "skip prompts, use defaults")
    .option("--catalog <dir:string>", "override bundled catalog directory")
    .option(
      "--var <kv...:string[]>",
      "repeatable; overrides one variable (KEY=VAL)",
      { collect: true },
    )
    .action(async (options) => {
      const providedVars = parseVarFlags(options.var)
      const { runWizard } = await import("./wizard.ts")
      await runWizard({
        cwd: Deno.cwd(),
        catalogDir: options.catalog,
        nonInteractive: options.nonInteractive,
        providedVars,
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
          .description(
            `Create a new server (writes servers/<name>/.env, encrypts).

Examples:

    rostok server create                  # interactive, prompts for everything
    rostok server create home             # name as positional arg
    rostok server create -n               # use defaults, fail fast on missing`,
          )
          .action(async (options, name?: string) => {
            await serverCreate({
              cwd: Deno.cwd(),
              nonInteractive: name ? { serverName: name } : undefined,
              failFast: options.nonInteractive,
            })
          }),
      ),
  )

  cmd.command(
    "stack",
    new Command()
      .description("Manage stacks from the bundled catalog.")
      .command(
        "add",
        new Command()
          .arguments("<name:string>")
          .option("-s, --server <name:string>", "target server", { required: true })
          .option("-n, --non-interactive", "skip prompts, use defaults")
          .option("--catalog <dir:string>", "override bundled catalog directory")
          .option(
            "--var <kv...:string[]>",
            "repeatable; overrides one variable (KEY=VAL)",
            { collect: true },
          )
          .description(
            `Add a stack to a server (resolves variables, writes .env, encrypts).

Examples:

    rostok stack add traefik -s home                    # interactive
    rostok stack add traefik -s home -n                 # non-interactive, defaults only
    rostok stack add traefik -s home \\
        --var DOMAIN=example.com \\
        --var BASIC_AUTH_USER=admin                     # pre-supply variables`,
          )
          .action(async (options, name: string) => {
            const catalogDir = options.catalog ?? undefined
            const providedVars = parseVarFlags(options.var)
            await stackAdd(name, options.server, {
              cwd: Deno.cwd(),
              catalogDir,
              providedVars,
              nonInteractive: options.nonInteractive,
            })
          }),
      )
      .command(
        "list",
        stackListCommand,
      ),
  )

  cmd.command("deploy", deployCommand)

  cmd.command("env", envCommand)

  return cmd
}

if (import.meta.main) {
  await buildCommand().parse(Deno.args)
}

/** Parse `--var KEY=VAL` flags into a record. */
function parseVarFlags(flags: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!flags) return out
  // Cliffy's `<kv...:string[]>` with `collect: true` produces a circular
  // structure: the last slot points back to the root array. Walk to a
  // bounded depth (strings live at depth 2 max) and bail on cycles.
  const flat: string[] = []
  const seen = new WeakSet<object>()
  const walk = (v: unknown, depth: number) => {
    if (typeof v === "string") {
      flat.push(v)
      return
    }
    if (depth > 4 || v === null || typeof v !== "object") return
    if (seen.has(v as object)) return // cycle — stop
    seen.add(v as object)
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
    }
  }
  walk(flags, 0)
  for (const f of flat) {
    const eq = f.indexOf("=")
    if (eq < 0) {
      throw new Error(`--var requires KEY=VAL form, got: ${f}`)
    }
    out[f.slice(0, eq)] = f.slice(eq + 1)
  }
  return out
}
