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
// Wiring smoke test for arktype — imports the module so deno.lock
// pins the dependency. Phase 3 replaces _arktypeOk with StackMeta.
import "./types.ts"

const WIZARD_PHASE = "v1 Phase 5"

export function buildCommand() {
  return new Command()
    .name(NAME)
    .version(VERSION)
    .description(DESCRIPTION)
    .action(() => {
      // Default action — wizard. Phase 5 implements init + server create +
      // stack add in one flow.
      console.log(`${NAME} v${VERSION}`)
      console.log("")
      console.log(`Onboarding wizard ships in ${WIZARD_PHASE}.`)
      console.log("Run `rostok --help` to see all commands.")
    })
    .command("server", serverCommand)
    .command("stack", stackCommand)
    .command("deploy", deployCommand)
}

if (import.meta.main) {
  await buildCommand().parse(Deno.args)
}
