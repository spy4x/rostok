// `rostok server ...` — manage servers (Phase 5 will flesh out).
//
// Phase 2 ships a stub so the help tree is meaningful and the command shape
// is locked in. The real `server create` flow lands with the wizard.

import { Command } from "@cliffy/command"
import { notImplemented } from "./+lib.ts"

export const serverCommand = new Command()
  .description("Manage rostok servers (Phase 5).")
  .command(
    "create",
    new Command()
      .arguments("[name:string]")
      .description("Create a new server. Phase 5.")
      .action(notImplemented("server create", "v1 Phase 5")),
  )
