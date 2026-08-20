// `rostok stack ...` — manage stacks from the bundled catalog.
//
// Phase 2 stub. `stack add` lands in Phase 5, `stack list [--tree]` in
// Phase 6 (parallel with Phase 5).

import { Command } from "@cliffy/command"
import { notImplemented } from "./+lib.ts"

export const stackCommand = new Command()
  .description("Manage stacks from the bundled catalog.")
  .command(
    "add",
    new Command()
      .arguments("<name:string>")
      .option("-s, --server <name:string>", "target server")
      .description("Add a stack to a server. Phase 5.")
      .action(notImplemented("stack add", "v1 Phase 5")),
  )
  .command(
    "list",
    new Command()
      .option("-t, --tree", "render dependency tree")
      .description("Browse the bundled catalog. Phase 6.")
      .action(notImplemented("stack list", "v1 Phase 6")),
  )
