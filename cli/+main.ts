// rostok CLI root entry.
//
// Phase 2 skeleton: `rostok --help` and `rostok --version` work.
// Subcommands are stubbed with phase pointers; the wizard lands in Phase 5.
//
// Build pattern: `buildCommand()` is exported so tests can construct a
// fresh Command per case without spawning subprocesses.

import { Command } from "@cliffy/command"
import { DESCRIPTION, NAME, VERSION } from "./version.ts"
import { serverCommand } from "./commands/server.ts"
import { stackCommand } from "./commands/stack.ts"
import { deployCommand } from "./commands/deploy.ts"
import { placeholderSchema } from "./types.ts"

const WIZARD_PHASE = "v1 Phase 5"

export function buildCommand(): Command {
  const cmd = new Command()
    .name(NAME)
    .version(VERSION)
    .description(DESCRIPTION)
    // arkType wiring — cliffy composes arktype schemas via .type().
    // Real schemas land in Phase 3; this proves the import path works.
    .type("placeholder", placeholderSchema)
    .action(() => {
      // Default action — wizard. Phase 5 implements init + server create +
      // stack add in one flow.
      console.log(`${NAME} v${VERSION}`)
      console.log("")
      console.log("Onboarding wizard ships in " + WIZARD_PHASE + ".")
      console.log("Run `rostok --help` to see all commands.")
    })

  cmd.command("server", serverCommand)
  cmd.command("stack", stackCommand)
  cmd.command("deploy", deployCommand)

  return cmd
}

if (import.meta.main) {
  await buildCommand().parse(Deno.args)
}
