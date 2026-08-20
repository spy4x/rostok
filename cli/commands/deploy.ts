// `rostok deploy <server> [stack]` — thin wrapper over `deno task deploy`.
//
// Phase 2 stub. Phase 7 will wire it to the project's deno.jsonc.

import { Command } from "@cliffy/command"

export const deployCommand = new Command()
  .description("Deploy a server (or one of its stacks). Phase 7.")
  .arguments("<server:string> [stack:string]")
  .action(() => {
    console.error("deploy: coming in v1 Phase 7. see docs/v1-cli.md.")
    Deno.exit(1)
  })
