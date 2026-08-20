// `rostok deploy <server> [stack]` — thin wrapper over `deno task deploy`.
//
// Phase 2 stub. Phase 7 will wire it to the project's deno.jsonc.

import { Command } from "@cliffy/command"
import { notImplemented } from "./+lib.ts"

export const deployCommand = new Command()
  .description("Deploy a server (or one of its stacks). Phase 7.")
  .arguments("<server:string> [stack:string]")
  .action(notImplemented("deploy", "v1 Phase 7"))
