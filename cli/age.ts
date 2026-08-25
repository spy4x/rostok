// age64 — per-value encryption with age.
//
// `KEY=age64:<base64-encoded-age-ciphertext>` format. Each value encrypted
// independently so unchanged values keep their original ciphertext
// byte-for-byte (zero diff noise in git).
//
// Key file: `<cwd>/.age/key.txt` (the user's project root).
//
// This module lives in cli/ because the CLI inlines encryption at the
// point of write (per docs/v1-cli.md §6, every `.env` mutation triggers
// re-encryption). scripts/encryption/* re-exports it for the standalone
// `deno task env:encrypt` workflow (rostok repo devs).
//
// Originally copied from scripts/encryption/age-lib.ts to make the CLI
// self-contained for JSR publishing — the previous shell-out to
// `deno task env:encrypt` failed when the user's project didn't define
// that task.

import { dirname, join } from "@std/path"
import { decodeBase64, encodeBase64 } from "@std/encoding"

const AGE64_PREFIX = "age64:"

/**
 * Resolve the .age/key.txt location. Looks for it in `cwd`'s git repo
 * (handles worktrees via --git-common-dir). Falls back to cwd if git
 * isn't available or the user isn't in a repo.
 */
function resolveKeyFile(cwd: string): string {
  try {
    const cmd = new Deno.Command("git", {
      args: ["rev-parse", "--git-common-dir"],
      stdout: "piped",
      stderr: "piped",
    })
    const out = cmd.outputSync()
    if (out.code === 0) {
      const gitDir = new TextDecoder().decode(out.stdout).trim()
      if (gitDir) return join(dirname(gitDir), ".age", "key.txt")
    }
  } catch { /* git missing — fall through */ }
  return join(cwd, ".age", "key.txt")
}

let _cachedKeyFile: string | undefined
function getAgeKeyFile(): string {
  if (_cachedKeyFile === undefined) _cachedKeyFile = resolveKeyFile(Deno.cwd())
  return _cachedKeyFile
}

export interface EnvEntry {
  /** Original line, preserves comments and blanks verbatim. */
  raw: string
  /** Env var key (undefined for comment/blank/malformed lines). */
  key?: string
  /** Plaintext value (undefined when line is age64-encrypted). */
  value?: string
  /** age64 ciphertext (undefined when line is plaintext). */
  encrypted?: string
}

/**
 * Read the recipient (public key) from the project's `.age/key.txt`.
 * Throws if the file is missing or the comment isn't present.
 */
export function getAgePublicKey(): string {
  const keyFile = getAgeKeyFile()
  const content = Deno.readTextFileSync(keyFile)
  const match = content.match(/# public key: (.+)/)
  if (!match) throw new Error(`age public key not found in ${keyFile}`)
  return match[1].trim()
}

/**
 * True if `age` CLI is on PATH. Used to gate encryption operations.
 */
export async function checkAgeInstalled(): Promise<boolean> {
  try {
    const out = await new Deno.Command("age", { args: ["--version"] }).output()
    return out.success
  } catch {
    return false
  }
}

/** Encrypt a plaintext value with age; return `age64:<base64>` form. */
export async function ageEncrypt(value: string, recipient?: string): Promise<string> {
  if (!recipient) recipient = getAgePublicKey()
  const cmd = new Deno.Command("age", {
    args: ["-r", recipient, "-o", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  })
  const proc = cmd.spawn()
  const writer = proc.stdin.getWriter()
  await writer.write(new TextEncoder().encode(value))
  await writer.close()
  const output = await proc.output()
  if (!output.success) {
    throw new Error("age encrypt failed: " + new TextDecoder().decode(output.stderr))
  }
  return AGE64_PREFIX + encodeBase64(new Uint8Array(output.stdout))
}

/** Decrypt an `age64:<base64>` value back to plaintext. */
export async function ageDecrypt(age64Value: string): Promise<string> {
  if (!age64Value.startsWith(AGE64_PREFIX)) {
    throw new Error("Not an age64 value: " + age64Value.slice(0, 20))
  }
  const ciphertext = decodeBase64(age64Value.slice(AGE64_PREFIX.length))
  const cmd = new Deno.Command("age", {
    args: ["-d", "-i", getAgeKeyFile(), "-o", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  })
  const proc = cmd.spawn()
  const writer = proc.stdin.getWriter()
  await writer.write(ciphertext)
  await writer.close()
  const output = await proc.output()
  if (!output.success) {
    throw new Error("age decrypt failed: " + new TextDecoder().decode(output.stderr))
  }
  return new TextDecoder().decode(output.stdout).trim()
}

/** True when `value` is an `age64:...` ciphertext (vs plaintext). */
export function isAge64(value: string): boolean {
  return value.startsWith(AGE64_PREFIX)
}

/**
 * Parse an env file into raw + structured entries. Comments and blanks
 * are preserved verbatim via `raw`; lines with `KEY=age64:...` get
 * `encrypted` set; other `KEY=val` lines get `value` set.
 *
 * Strips matched single/double quotes around the value (one layer only).
 */
export function parseEnvFile(content: string): EnvEntry[] {
  const entries: EnvEntry[] = []
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      entries.push({ raw: line })
      continue
    }
    const eqIdx = line.indexOf("=")
    if (eqIdx === -1) {
      entries.push({ raw: line })
      continue
    }
    const key = line.slice(0, eqIdx).trim()
    let value = line.slice(eqIdx + 1)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    const encrypted = isAge64(value) ? value : undefined
    entries.push({ raw: line, key, value, encrypted })
  }
  return entries
}

/** True if `dir` has its own .git checkout (worktree, submodule, clone). */
async function isNestedCheckout(dir: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(join(dir, ".git"))
    return stat.isDirectory || stat.isFile
  } catch {
    return false
  }
}

/**
 * Walk `rootDir` for `.env` files (top-level + subdirs, skipping hidden
 * dirs and nested checkouts). Matches the existing findEnvFiles from
 * scripts/encryption/age-lib.ts.
 */
export async function findEnvFiles(rootDir: string = Deno.cwd()): Promise<string[]> {
  const results: string[] = []
  await walkEnvDir(rootDir, results, /^\.env/)
  return results.sort()
}

async function walkEnvDir(
  dir: string,
  results: string[],
  nameFilter: RegExp,
): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      if (await isNestedCheckout(path)) continue
      await walkEnvDir(path, results, nameFilter)
      continue
    }
    if (
      nameFilter.test(entry.name) &&
      !entry.name.includes(".example") &&
      !entry.name.includes(".sops-backup") &&
      !entry.name.endsWith(".age")
    ) {
      results.push(path)
    }
  }
}

/** Walk `rootDir` for `.env*.age` files (matching the env naming pattern). */
export async function findAgeFiles(rootDir: string = Deno.cwd()): Promise<string[]> {
  const results: string[] = []
  for await (const entry of Deno.readDir(rootDir)) {
    const path = join(rootDir, entry.name)
    if (entry.isDirectory) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      if (await isNestedCheckout(path)) continue
      await walkAgeDir(path, results)
      continue
    }
    if (isEnvAgeFile(entry.name)) results.push(path)
  }
  return results.sort()
}

async function walkAgeDir(dir: string, results: string[]): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      if (await isNestedCheckout(path)) continue
      await walkAgeDir(path, results)
      continue
    }
    if (isEnvAgeFile(entry.name)) results.push(path)
  }
}

/** True if `name` is an env-naming `.age` file (e.g. `.env.age`, `.env.prod.age`). */
function isEnvAgeFile(name: string): boolean {
  if (!name.endsWith(".age")) return false
  if (name.endsWith(".sops-backup.age")) return false
  if (name.includes(".example")) return false
  return name.includes(".env")
}

/** Map an env file to its .age sibling (just appends `.age`). */
export function getEnvAgePath(envPath: string): string {
  return envPath + ".age"
}
