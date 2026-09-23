// Thin wrapper so `deno task deploy <server> [stack]` keeps working in
// this repo. The actual logic moved to cli/deploy/run-deploy.ts (#203) so
// `rostok deploy` can run it in-process from a project that has no
// `scripts/` directory at all (every published-CLI project).
//
// Usage: deno run -A scripts/deploy/+main.ts <server> [stack]
// Example: deno run -A scripts/deploy/+main.ts home
// Example: deno run -A scripts/deploy/+main.ts home traefik

import { UserError } from "../../cli/errors.ts"
import { runDeploy } from "../../cli/deploy/run-deploy.ts"

const [server, stack] = Deno.args
if (!server) {
  console.error("Usage: deno run -A scripts/deploy/+main.ts <server> [stack]")
  console.error("Example: deno run -A scripts/deploy/+main.ts home")
  console.error("Example: deno run -A scripts/deploy/+main.ts home plausible")
  Deno.exit(1)
}

try {
  await runDeploy({ cwd: Deno.cwd(), server, stack })
} catch (err) {
  if (err instanceof UserError) {
    console.error(`deploy: ${err.message}`)
    Deno.exit(1)
  }
  throw err
}
