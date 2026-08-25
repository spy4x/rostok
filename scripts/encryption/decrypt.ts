/**
 * env:decrypt — thin wrapper around cli/encrypt.ts.decryptEnvFiles.
 *
 * Runs decryption inline for rostok repo devs. JSR-published users use
 * `rostok env decrypt` instead.
 */

import { decryptEnvFiles } from "../../cli/encrypt.ts"

async function main() {
  console.log(" decrypting env files (age64)...")
  const result = await decryptEnvFiles(Deno.cwd())
  if (!result.ok && !result.skipped) {
    console.error(` env:decrypt failed: ${result.output}`)
    Deno.exit(1)
  }
  if (result.output) console.log(` ${result.output}`)
}

if (import.meta.main) await main()
