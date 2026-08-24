// age64 encryption wrapper for the wizard.
//
// Per docs/v1-cli.md §6, every `.env` mutation triggers re-encryption of
// the corresponding `.env.age`. The actual encryption logic lives in
// `scripts/encryption/encrypt.ts` (existing age64 flow). This module
// shells out to `deno task env:encrypt` after each write so `.env.age`
// stays in sync with `.env` — but ONLY when `age` is installed.
//
// **Encryption is optional but endorsed.** If `age` is missing on PATH,
// `encryptEnvFiles` skips silently (one-time info tip) — the wizard
// completes regardless. The user can install `age` later and run
// `rostok env encrypt` manually to backfill `.env.age`.
//
// Failures from the encrypt task itself (e.g. age present but no key
// file) are also non-fatal — they're warned, not thrown.

import { exists } from "@std/fs"
import { join } from "@std/path"

/** Cache of age availability — checked once per CLI invocation. */
let _ageInstalled: boolean | undefined
let _ageHintShown = false

/**
 * Detect whether the `age` CLI is on PATH. Cached per process.
 * Imported from scripts/encryption/age-lib.ts for a single source of truth
 * (also used by the encrypt/decrypt tasks themselves).
 */
export async function checkAgeInstalled(): Promise<boolean> {
  if (_ageInstalled !== undefined) return _ageInstalled
  try {
    const cmd = new Deno.Command("age", { args: ["--version"], stdout: "null", stderr: "null" })
    const out = await cmd.output()
    _ageInstalled = out.success
  } catch {
    _ageInstalled = false
  }
  return _ageInstalled
}

/**
 * True when `.age/key.txt` exists in the project root. Encryption will
 * fail without this file even if `age` is on PATH.
 */
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
 *
 * Pre-conditions: age-keygen on PATH, .age/ writable, .age/key.txt
 * absent. Caller checks these.
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

/** Print the "install age" tip at most once per CLI invocation. */
export function maybeShowAgeHint(context: string): void {
  if (_ageHintShown) return
  _ageHintShown = true
  console.info(
    `rostok: age not installed — skipping ${context}. install with \`apt install age\`` +
      ` and run \`age-keygen -o .age/key.txt\` to enable encrypted commits.`,
  )
}

export interface EncryptResult {
  ok: boolean
  /** Captured stdout+stderr from the encrypt task. */
  output: string
  /** Why the task didn't run (only set when `ok=false` and we skipped). */
  skipped?: "no-age" | "no-key" | "no-env-files"
}

/**
 * Run `deno task env:encrypt` in `cwd`. Returns ok=true on exit code 0.
 *
 * If `age` is not on PATH: emits a one-time info tip, returns
 * `{ ok: false, skipped: "no-age" }` WITHOUT invoking the subprocess
 * (the task would just exit 1 with the same hint).
 *
 * If `age` is installed but `.age/key.txt` is missing: emits a one-time
 * tip about generating a keypair, returns `{ ok: false, skipped: "no-key" }`.
 *
 * Other failures (the task ran and exited non-zero) return
 * `{ ok: false, output }` with the captured output.
 *
 * Caller is responsible for `cwd` — pass the project root that contains
 * the `.env` / `.env.age` files to re-encrypt.
 */
export async function encryptEnvFiles(cwd: string): Promise<EncryptResult> {
  return await runEncryptionTask(cwd, "encrypt", "deno task env:encrypt")
}

/**
 * Symmetric counterpart to {@link encryptEnvFiles}. Runs
 * `deno task env:decrypt`. Same skip semantics — `age` missing ⇒ skip
 * silently with a one-time hint.
 */
export async function decryptEnvFiles(cwd: string): Promise<EncryptResult> {
  return await runEncryptionTask(cwd, "decrypt", "deno task env:decrypt")
}

/**
 * Shared implementation for encrypt/decrypt. The "no-env-files" skip is
 * only meaningful for encrypt (decrypting nothing is fine and produces
 * zero output), so we gate it on the action.
 */
async function runEncryptionTask(
  cwd: string,
  action: "encrypt" | "decrypt",
  cmdArgs: string,
): Promise<EncryptResult> {
  const ageOk = await checkAgeInstalled()
  if (!ageOk) {
    maybeShowAgeHint(`${action} of .env.age`)
    return { ok: false, output: "", skipped: "no-age" }
  }

  const keyOk = await checkAgeKeyPresent(cwd)
  if (!keyOk) {
    maybeShowAgeHintOnce(`${action} — .age/key.txt missing`, action)
    return { ok: false, output: "", skipped: "no-key" }
  }

  const cmd = new Deno.Command(Deno.execPath(), {
    args: cmdArgs.split(" ").slice(1), // drop "deno"
    cwd,
    stdout: "piped",
    stderr: "piped",
  })
  const out = await cmd.output()
  const output = new TextDecoder().decode(
    new Uint8Array([...out.stdout, ...out.stderr]),
  )
  if (out.success) return { ok: true, output }
  // Non-fatal: warn, don't throw. The .env file is still written.
  console.warn(`env:${action} failed (cwd=${cwd}):`)
  console.warn(output)
  return { ok: false, output }
}

/** Per-action dedup so encrypt and decrypt can each show their own hint. */
const _perActionHint = new Set<string>()
function maybeShowAgeHintOnce(msg: string, action: string): void {
  const k = `${action}:${msg}`
  if (_perActionHint.has(k)) return
  _perActionHint.add(k)
  console.info(`rostok: ${msg}. run \`rostok env setup\` to generate one.`)
}

/**
 * Snapshot of the project's encryption state. Used by `rostok env status`
 * and exposed for tests. Cheap to compute — just stat calls.
 */
export interface AgeStatus {
  ageInstalled: boolean
  ageKeyPresent: boolean
  envFiles: string[]
  ageFiles: string[]
}

/**
 * Inspect the project's encryption posture. Doesn't read file contents;
 * only checks PATH for `age` and stats for the key/env files. Safe to
 * call any number of times.
 */
export async function ageStatus(cwd: string): Promise<AgeStatus> {
  const envFiles: string[] = []
  const ageFiles: string[] = []
  await collectEnvAndAge(cwd, envFiles, ageFiles)
  return {
    ageInstalled: await checkAgeInstalled(),
    ageKeyPresent: await checkAgeKeyPresent(cwd),
    envFiles: envFiles.sort(),
    ageFiles: ageFiles.sort(),
  }
}

/** Walk `cwd` for `.env*` and `.env*.age` files. Matches findEnvFiles in
 *  scripts/encryption/age-lib.ts — top-level + all non-hidden subdirs. */
async function collectEnvAndAge(
  cwd: string,
  envFiles: string[],
  ageFiles: string[],
): Promise<void> {
  for await (const entry of Deno.readDir(cwd)) {
    // Skip other hidden dirs (.git, .cache, ...) but NOT .env* files.
    if (entry.isDirectory && entry.name.startsWith(".")) continue
    if (entry.name === "node_modules") continue
    const full = join(cwd, entry.name)
    if (entry.isDirectory) {
      // Skip nested git checkouts (.git file or .git dir) so we don't
      // recurse into another branch's secrets.
      if (await isNestedCheckout(full)) continue
      await collectEnvAndAge(full, envFiles, ageFiles)
      continue
    }
    if (entry.name.endsWith(".age")) {
      ageFiles.push(full)
    } else if (
      entry.name === ".env" ||
      entry.name === ".env.root" ||
      (entry.name.startsWith(".env.") && !entry.name.endsWith(".example"))
    ) {
      envFiles.push(full)
    }
  }
}

/** True if `dir` is a separate git checkout (worktree, submodule, clone). */
async function isNestedCheckout(dir: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(join(dir, ".git"))
    return stat.isDirectory || stat.isFile
  } catch {
    return false
  }
}
