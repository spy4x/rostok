/**
 * env:encrypt — .env → .env.age (diff-based, only re-encrypt changed values)
 *
 * Reads each .env file, compares with existing .env.age, and produces
 * updated .env.age where only changed/new values get re-encrypted.
 * Unchanged values keep their existing age64 ciphertext — zero diff noise.
 */

import {
  ageDecrypt,
  ageEncrypt,
  checkAgeInstalled,
  findEnvFiles,
  getEnvAgePath,
  getRelativePath,
  parseEnvFile,
} from "./age-lib.ts"
import { exists } from "@std/fs"

/**
 * One occurrence of a key in an existing .env.age: its raw line + plaintext.
 *
 * `encrypted` records whether the raw line actually carried age64 ciphertext.
 * A line that did not is never safe to reuse verbatim — see indexOldAge.
 */
export type OldOccurrence = { raw: string; plain: string; encrypted: boolean }

/**
 * Index an existing .env.age by *occurrence* rather than by key.
 *
 * A .env may legitimately define the same key twice (at runtime the later one
 * wins). A key → value dict would keep only the last value, so every earlier
 * occurrence would compare unequal and be re-encrypted on every run.
 *
 * Occurrences whose .env.age line was NOT age64 ciphertext are still indexed,
 * to keep the positional match aligned, but are flagged so they are never
 * reused. Reusing one would re-emit a plaintext secret into .env.age and keep
 * doing so forever, since the value compares equal on every subsequent run.
 */
export async function indexOldAge(
  oldContent: string,
  decrypt: (v: string) => Promise<string>,
): Promise<Map<string, OldOccurrence[]>> {
  const byKey = new Map<string, OldOccurrence[]>()
  for (const e of parseEnvFile(oldContent)) {
    if (!e.key) continue
    const encrypted = Boolean(e.encrypted)
    const plain = encrypted ? await decrypt(e.encrypted!) : e.value ?? ""
    const list = byKey.get(e.key) ?? []
    list.push({ raw: e.raw, plain, encrypted })
    byKey.set(e.key, list)
  }
  return byKey
}

/**
 * Render .env.age content from a .env, reusing the existing ciphertext for
 * every value that has not changed. Pure apart from the injected `encrypt`.
 */
export async function renderAgeContent(
  newContent: string,
  oldOccurrences: Map<string, OldOccurrence[]>,
  encrypt: (v: string) => Promise<string>,
): Promise<string> {
  const outputLines: string[] = []
  const keyCounts = new Map<string, number>() // key → occurrences seen so far

  for (const entry of parseEnvFile(newContent)) {
    if (!entry.key) {
      // Preserve comments/blanks from the new .env verbatim
      outputLines.push(entry.raw)
      continue
    }

    const newVal = entry.value ?? ""

    // Compare against the matching occurrence of this key in .env.age
    const nth = keyCounts.get(entry.key) ?? 0
    keyCounts.set(entry.key, nth + 1)
    const old = oldOccurrences.get(entry.key)?.[nth]

    if (old !== undefined && old.encrypted && old.plain === newVal) {
      outputLines.push(old.raw) // unchanged — keep existing ciphertext
      continue
    }

    outputLines.push(`${entry.key}=${await encrypt(newVal)}`)
  }

  // Keys removed from .env but present in .env.age → dropped (not included).
  //
  // Comments and blank lines are already carried over from the new .env above,
  // and .env is itself generated from .env.age by env:decrypt, so every comment
  // round-trips. Re-appending leftover non-key lines from the old .env.age
  // would resurrect comments deliberately deleted from .env and pile up blank
  // lines on every run.
  //
  // outputLines already ends with an empty entry whenever .env ended with a
  // newline (split("\n") yields a trailing ""), so join("\n") + "\n" would add
  // a second one every run — permanent one-line diff noise. Normalize to
  // exactly one trailing newline.
  return outputLines.join("\n").replace(/\n*$/, "") + "\n"
}

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

      const oldOccurrences = await exists(agePath)
        ? await indexOldAge(Deno.readTextFileSync(agePath), ageDecrypt)
        : new Map<string, OldOccurrence[]>()

      const output = await renderAgeContent(newContent, oldOccurrences, ageEncrypt)
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
