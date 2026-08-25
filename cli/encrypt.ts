// age64 encryption wrapper for the wizard.
//
// Per docs/v1-cli.md §6, every `.env` mutation triggers re-encryption of
// the corresponding `.env.age`. The encryption runs INLINE in the CLI
// process now (no `deno task env:encrypt` shell-out) — earlier designs
// relied on the user's deno.jsonc defining that task, but the wizard
// ships a minimal deno.jsonc template that doesn't.
//
// **Encryption is optional but endorsed.** If `age` is missing on PATH,
// `encryptEnvFiles` skips silently (one-time info tip) — the wizard
// completes regardless. The user can install `age` later and run
// `rostok env encrypt` manually to backfill `.env.age`.
//
// Failures from the encryption step itself (e.g. age present but no key
// file) are also non-fatal — they're warned, not thrown.

import { exists } from "@std/fs"
import { join } from "@std/path"
import {
  ageDecrypt,
  ageEncrypt,
  checkAgeInstalled,
  findAgeFiles,
  findEnvFiles,
  getEnvAgePath,
  parseEnvFile,
} from "./age.ts"

/** Detect whether the `age` CLI is on PATH. Thin wrapper for clarity. */
export async function checkAgeKeyPresent(cwd: string): Promise<boolean> {
  return await exists(join(cwd, ".age", "key.txt"))
}

/**
 * Result of {@link generateAgeKey}.
 */
export interface GenerateKeyResult {
  ok: boolean
  /** Absolute path to the generated key file (relative to cwd if ok). */
  path: string
  /** Parsed `public key: age1...` line from the key file (safe to share). */
  publicKey?: string
  /** Captured stderr when `ok=false`. */
  error?: string
}

/**
 * Generate an age keypair via `age-keygen -o <cwd>/.age/key.txt`. Used by
 * `cli/init.ts` (interactive prompt after init) and `cli/commands/env.ts`
 * (`rostok env setup`). The CLI never asks the user to run `age-keygen`
 * themselves — this is the wrapper that hides that command.
 */
export async function generateAgeKey(cwd: string): Promise<GenerateKeyResult> {
  const keyPath = join(cwd, ".age", "key.txt")
  await Deno.mkdir(join(cwd, ".age"), { recursive: true }).catch(() => {})
  try {
    const cmd = new Deno.Command("age-keygen", {
      args: ["-o", keyPath],
      stdout: "piped",
      stderr: "piped",
    })
    const out = await cmd.output()
    if (!out.success) {
      return {
        ok: false,
        path: keyPath,
        error: new TextDecoder().decode(out.stderr).trim() || "age-keygen exited non-zero",
      }
    }
    // age-keygen prints the public key on stdout; parse it as a fallback
    // in case the file doesn't contain it for some reason.
    const stdout = new TextDecoder().decode(out.stdout)
    const publicKey = stdout.match(/Public key: (\S+)/)?.[1] ??
      (await safeReadPublicKey(keyPath))
    return { ok: true, path: keyPath, publicKey }
  } catch (err) {
    return {
      ok: false,
      path: keyPath,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Parse the `# public key: age1...` line from a key file. Best effort. */
async function safeReadPublicKey(keyPath: string): Promise<string | undefined> {
  try {
    const text = await Deno.readTextFile(keyPath)
    return text.match(/# public key: (\S+)/)?.[1]
  } catch {
    return undefined
  }
}

/** Print a hint at most once per CLI invocation (per-key dedup). */
const _hintShown = new Set<string>()
function hintOnce(key: string, msg: string): void {
  if (_hintShown.has(key)) return
  _hintShown.add(key)
  console.info(`rostok: ${msg}`)
}

/** Back-compat shim — `checkAgeInstalled` already exists in age.ts. */
export { checkAgeInstalled }

/**
 * Snapshot of the project's encryption state. Used by `rostok env status`
 * and exposed for tests.
 */
export interface AgeStatus {
  ageInstalled: boolean
  ageKeyPresent: boolean
  envFiles: string[]
  ageFiles: string[]
}

/** Inspect the project's encryption posture. */
export async function ageStatus(cwd: string): Promise<AgeStatus> {
  const envFiles = await findEnvFiles(cwd)
  const ageFiles = await findAgeFiles(cwd)
  return {
    ageInstalled: await checkAgeInstalled(),
    ageKeyPresent: await checkAgeKeyPresent(cwd),
    envFiles,
    ageFiles,
  }
}

export interface EncryptResult {
  ok: boolean
  /** Captured log from the encrypt run (mostly empty in inline mode). */
  output: string
  /** Why the operation didn't run (only set when `ok=false` and we skipped). */
  skipped?: "no-age" | "no-key" | "no-env-files"
}

/**
 * Re-encrypt every `.env` file under `cwd` to its `.env.age` sibling.
 *
 * Skips silently (returns `skipped`) when:
 *   - `age` is not on PATH → one-time install hint
 *   - `.age/key.txt` is missing → one-time hint to run `rostok env setup`
 *   - no `.env` files exist → nothing to do
 *
 * On any per-file failure: logs the error, marks the run as failed, but
 * continues with remaining files (one bad value shouldn't kill the run).
 */
export async function encryptEnvFiles(cwd: string): Promise<EncryptResult> {
  if (!(await checkAgeInstalled())) {
    hintOnce(
      "age-missing:encrypt",
      "age not installed — skipping encryption of .env.age. " +
        `install with \`apt install age\` and run \`rostok env setup\` to enable encryption.`,
    )
    return { ok: false, output: "", skipped: "no-age" }
  }
  if (!(await checkAgeKeyPresent(cwd))) {
    hintOnce(
      "no-key:encrypt",
      "encrypt: .age/key.txt missing. run `rostok env setup` to generate one.",
    )
    return { ok: false, output: "", skipped: "no-key" }
  }

  const envFiles = await findEnvFiles(cwd)
  if (envFiles.length === 0) {
    return { ok: true, output: "no .env files", skipped: "no-env-files" }
  }

  let okCount = 0
  let failCount = 0
  const errors: string[] = []
  for (const envPath of envFiles) {
    const agePath = getEnvAgePath(envPath)
    try {
      const newContent = Deno.readTextFileSync(envPath)
      const oldContent = await exists(agePath) ? Deno.readTextFileSync(agePath) : ""
      const oldOccurrences = await indexOldAge(oldContent, ageDecrypt)
      const output = await renderAgeContent(newContent, oldOccurrences, ageEncrypt)
      Deno.writeTextFileSync(agePath, output)
      okCount++
    } catch (err) {
      failCount++
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${envPath}: ${msg}`)
      console.warn(`env:encrypt: ${envPath} failed: ${msg}`)
    }
  }

  if (failCount > 0) {
    return { ok: false, output: errors.join("\n") }
  }
  return { ok: true, output: `${okCount} file(s) encrypted` }
}

/**
 * Symmetric counterpart: decrypt every `.env.age` under `cwd` to its
 * `.env` sibling. Skips with the same precondition semantics as encrypt.
 */
export async function decryptEnvFiles(cwd: string): Promise<EncryptResult> {
  if (!(await checkAgeInstalled())) {
    hintOnce(
      "age-missing:decrypt",
      "age not installed — skipping decryption of .env.age. " +
        "install with `apt install age` and re-run.",
    )
    return { ok: false, output: "", skipped: "no-age" }
  }
  if (!(await checkAgeKeyPresent(cwd))) {
    hintOnce(
      "no-key:decrypt",
      "decrypt: .age/key.txt missing. can't decrypt without a key.",
    )
    return { ok: false, output: "", skipped: "no-key" }
  }

  const ageFiles = await findAgeFiles(cwd)
  if (ageFiles.length === 0) {
    return { ok: true, output: "no .env.age files", skipped: "no-env-files" }
  }

  let okCount = 0
  let failCount = 0
  const errors: string[] = []
  for (const agePath of ageFiles) {
    const envPath = agePath.slice(0, -".age".length)
    try {
      const content = Deno.readTextFileSync(agePath)
      const entries = parseEnvFile(content)
      const out: string[] = []
      for (const e of entries) {
        if (!e.key) {
          out.push(e.raw)
          continue
        }
        const value = e.encrypted ? await ageDecrypt(e.encrypted) : (e.value ?? "")
        out.push(`${e.key}=${value}`)
      }
      // Normalize trailing newline to exactly one.
      Deno.writeTextFileSync(envPath, out.join("\n").replace(/\n*$/, "") + "\n")
      okCount++
    } catch (err) {
      failCount++
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`${agePath}: ${msg}`)
      console.warn(`env:decrypt: ${agePath} failed: ${msg}`)
    }
  }

  if (failCount > 0) return { ok: false, output: errors.join("\n") }
  return { ok: true, output: `${okCount} file(s) decrypted` }
}

// ─────────────────────────────────────────────────────────────────────
// age64 rendering — ported from scripts/encryption/encrypt.ts.
//
// Reused by cli/encrypt.ts to keep unchanged values' ciphertext byte-for-
// byte identical (zero diff noise in git).
// ─────────────────────────────────────────────────────────────────────

interface OldOccurrence {
  raw: string
  plain: string
  encrypted: boolean
}

/**
 * Index an existing `.env.age` by *occurrence* rather than by key.
 *
 * A `.env` may legitimately define the same key twice (runtime: the
 * later one wins). A key → value dict would keep only the last value,
 * so earlier occurrences would compare unequal and be re-encrypted on
 * every run.
 *
 * Occurrences whose `.env.age` line was NOT age64 ciphertext are still
 * indexed (to keep the positional match aligned) but are flagged so
 * they are never reused — reusing one would re-emit a plaintext
 * secret into `.env.age` and keep doing so forever.
 */
export async function indexOldAge(
  oldContent: string,
  decrypt: (v: string) => Promise<string>,
): Promise<Map<string, OldOccurrence[]>> {
  const byKey = new Map<string, OldOccurrence[]>()
  for (const e of parseEnvFile(oldContent)) {
    if (!e.key) continue
    const plain = e.encrypted ? await decrypt(e.encrypted) : (e.value ?? "")
    const list = byKey.get(e.key) ?? []
    list.push({ raw: e.raw, plain, encrypted: Boolean(e.encrypted) })
    byKey.set(e.key, list)
  }
  return byKey
}

/**
 * Render `.env.age` content from a `.env`, reusing existing ciphertext
 * for every value that hasn't changed.
 */
export async function renderAgeContent(
  newContent: string,
  oldOccurrences: Map<string, OldOccurrence[]>,
  encrypt: (v: string) => Promise<string>,
): Promise<string> {
  const outputLines: string[] = []
  const keyCounts = new Map<string, number>()

  for (const entry of parseEnvFile(newContent)) {
    if (!entry.key) {
      outputLines.push(entry.raw)
      continue
    }
    const newVal = entry.value ?? ""

    const nth = keyCounts.get(entry.key) ?? 0
    keyCounts.set(entry.key, nth + 1)
    const old = oldOccurrences.get(entry.key)?.[nth]

    if (old !== undefined && old.encrypted && old.plain === newVal) {
      outputLines.push(old.raw) // unchanged — keep existing ciphertext
      continue
    }

    outputLines.push(`${entry.key}=${await encrypt(newVal)}`)
  }

  // Normalize trailing newline to exactly one.
  return outputLines.join("\n").replace(/\n*$/, "") + "\n"
}
