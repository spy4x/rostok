/**
 * env:encrypt — .env → .env.age (diff-based, only re-encrypt changed values)
 *
 * Reads each .env file, compares with existing .env.age, and produces
 * updated .env.age where only changed/new values get re-encrypted.
 * Unchanged values keep their existing age64 ciphertext — zero diff noise.
 */

import {
  ageEncrypt,
  checkAgeInstalled,
  findEnvFiles,
  getEnvAgePath,
  getRelativePath,
  parseEnvDict,
  parseEnvFile,
} from "./age-lib.ts"
import { exists } from "@std/fs"

async function main() {
  console.log(" encrypting env files (age64)...")

  const ageOk = await checkAgeInstalled()
  if (!ageOk) {
    console.error(" age not found. Install: sudo apt install age")
    Deno.exit(1)
  }

  const envFiles = await findEnvFiles()
  if (envFiles.length === 0) {
    console.log(" No .env files found")
    Deno.exit(0)
  }

  console.log(`Found ${envFiles.length} file(s):\n`)

  let ok = 0, fail = 0

  for (const envPath of envFiles) {
    const relPath = getRelativePath(envPath)
    const agePath = getEnvAgePath(envPath)
    console.log(`   ${relPath}`)

    try {
      const newContent = Deno.readTextFileSync(envPath)
      const newEntries = parseEnvFile(newContent)

      // Build old plaintext dict + old raw lines if .env.age exists
      let oldPlain: Record<string, string> = {}
      const oldLines: Record<string, string> = {} // key → raw line from .env.age
      const oldRawLines: string[] = [] // ALL lines (key + comment + blank) for orphan-comment detection
      const oldComments: string[] = [] // non-key lines for orphan-comment detection

      if (await exists(agePath)) {
        const oldContent = Deno.readTextFileSync(agePath)
        const oldEntries = parseEnvFile(oldContent)
        oldPlain = await parseEnvDict(oldEntries)
        for (const e of oldEntries) {
          oldRawLines.push(e.raw)
          if (e.key) {
            oldLines[e.key] = e.raw
          } else {
            oldComments.push(e.raw)
          }
        }
      }

      // Build output: for each new line, keep old encrypted if unchanged
      const outputLines: string[] = []
      const seen = new Set<string>()

      for (const entry of newEntries) {
        if (!entry.key) {
          // Preserve comments/blanks from new .env
          outputLines.push(entry.raw)
          continue
        }

        seen.add(entry.key)
        const newVal = entry.value ?? ""

        // Check if value unchanged from old
        const oldVal = oldPlain[entry.key]
        if (oldVal !== undefined && oldVal === newVal && oldLines[entry.key]) {
          // Unchanged — keep existing encrypted line
          outputLines.push(oldLines[entry.key])
          continue
        }

        // Value changed or new key — encrypt
        const encrypted = await ageEncrypt(newVal)
        outputLines.push(`${entry.key}=${encrypted}`)
      }

      // Keys removed from .env but present in .env.age → drop (not included)

      // Add remaining comments from old .env.age — only if their keys still exist.
      // Drop orphan region comments from deleted regions (e.g. removed #region/#endregion pairs).
      for (const comment of oldComments) {
        if (outputLines.includes(comment)) continue
        // Find this comment's position in the full old-line sequence
        const idx = oldRawLines.indexOf(comment)
        if (idx === -1) continue
        // Look for the next KEY line after this comment in the old file
        let nextKey: string | undefined
        for (let j = idx + 1; j < oldRawLines.length; j++) {
          const next = oldRawLines[j]
          const trimmed = next.trim()
          if (!trimmed || trimmed.startsWith("#")) continue
          const eqIdx = next.indexOf("=")
          if (eqIdx > 0) {
            nextKey = next.slice(0, eqIdx).trim()
            break
          }
        }
        // If no following key, this is a trailing orphan — skip unless it's blank (preserve spacing)
        if (!nextKey) {
          if (comment.trim() === "") {
            outputLines.push(comment)
          }
          continue
        }
        // If following key was removed, drop this orphan comment
        if (!seen.has(nextKey)) continue
        outputLines.push(comment)
      }

      // Write
      const output = outputLines.join("\n") + "\n"
      Deno.writeTextFileSync(agePath, output)
      console.log(`      -> ${getRelativePath(agePath)}`)
      ok++
    } catch (err) {
      console.error(`      FAILED: ${err instanceof Error ? err.message : String(err)}`)
      fail++
    }
  }

  console.log(
    `\n${fail > 0 ? "" : ""} ${ok}/${envFiles.length} file(s) encrypted${
      fail > 0 ? ` (${fail} failed)` : ""
    }`,
  )
  if (fail > 0) Deno.exit(1)
}

if (import.meta.main) await main()
