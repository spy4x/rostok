/**
 * env:encrypt — thin wrapper around cli/encrypt.ts.encryptEnvFiles.
 *
 * Runs encryption inline (no subprocess) for rostok repo devs who
 * invoke `deno task env:encrypt` from the repo itself. JSR-published
 * users use `rostok env encrypt` instead — the binary handles the
 * same logic.
 */

import { encryptEnvFiles } from "../../cli/encrypt.ts"

async function main() {
  console.log(" encrypting env files (age64)...")
  const result = await encryptEnvFiles(Deno.cwd())
  if (!result.ok && !result.skipped) {
    console.error(` env:encrypt failed: ${result.output}`)
    Deno.exit(1)
  }
  if (result.output) console.log(` ${result.output}`)
}

if (import.meta.main) await main()
