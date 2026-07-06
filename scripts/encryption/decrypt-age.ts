#!/usr/bin/env deno run --allow-read --allow-write --allow-run

/**
 * age64 decrypt: .env.age → .env
 *
 * Reads each .env.age file, decrypts age64 values, writes .env with
 * all values in plaintext. Non-secret values pass through unchanged.
 */

import {
  ageDecrypt,
  checkAgeInstalled,
  findEnvFiles,
  getEnvAgePath,
  getRelativePath,
  parseEnvFile,
  serializeEnv,
} from "./age-lib.ts"
import { exists } from "@std/fs"

async function main() {
  console.log(" decrypting env files (age64)...")

  const ageOk = await checkAgeInstalled()
  if (!ageOk) {
    console.error(" age not found. Install: sudo apt install age")
    Deno.exit(1)
  }

  // Find .env.age files (look for .env, then check if .env.age exists)
  const envFiles = await findEnvFiles()
  const ageFiles: string[] = []

  for (const envPath of envFiles) {
    const agePath = getEnvAgePath(envPath)
    if (await exists(agePath)) {
      ageFiles.push(agePath)
    }
  }

  if (ageFiles.length === 0) {
    console.log(" No .env.age files found")
    Deno.exit(0)
  }

  console.log(`Found ${ageFiles.length} file(s):\n`)

  let ok = 0, fail = 0

  for (const agePath of ageFiles) {
    const relPath = getRelativePath(agePath)
    const envPath = agePath.replace(/\.age$/, "")
    const envRelPath = getRelativePath(envPath)

    console.log(`   ${relPath}`)

    try {
      const content = Deno.readTextFileSync(agePath)
      const entries = parseEnvFile(content)

      // Decrypt age64 values in-place
      for (const entry of entries) {
        if (entry.encrypted) {
          entry.value = await ageDecrypt(entry.encrypted)
          // Rebuild raw line with plaintext value
          entry.raw = `${entry.key}=${entry.value}`
          entry.encrypted = undefined
        }
      }

      const output = serializeEnv(entries)
      Deno.writeTextFileSync(envPath, output)
      console.log(`      -> ${envRelPath}`)
      ok++
    } catch (err) {
      console.error(`      FAILED: ${err instanceof Error ? err.message : String(err)}`)
      fail++
    }
  }

  console.log(`\n${ok}/${ageFiles.length} file(s) decrypted${fail > 0 ? ` (${fail} failed)` : ""}`)
  if (fail > 0) Deno.exit(1)
}

if (import.meta.main) await main()
