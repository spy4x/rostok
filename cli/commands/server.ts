// `rostok server ...` — manage servers (Phase 5 will flesh out).
//
// Phase 2 ships a stub so the help tree is meaningful and the command shape
// is locked in. The real `server create` flow lands with the wizard.

import { Command } from "@cliffy/command"

const notImplemented = (phase: string) => () => {
  console.error(`server: coming in ${phase}. see docs/v1-cli.md.`)
  Deno.exit(1)
}

export const serverCommand = new Command()
  .description("Manage rostok servers (Phase 5).")
  .command(
    "create",
    new Command()
      .arguments("[name:string]")
      .description("Create a new server. Phase 5.")
      .action(notImplemented("v1 Phase 5")),
  )
