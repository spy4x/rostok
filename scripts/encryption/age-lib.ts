/**
 * age64: per-value encryption with age
 * Format: KEY=age64:<base64-encoded-age-ciphertext>
 *
 * Each value encrypted independently. Only changed values show in git diff.
 * Unchanged values keep their original ciphertext byte-for-byte.
 *
 * Key file: .age/key.txt in repo root
 * Public key: extracted from .age/key.txt comment
 */
import { dirname, join } from "@std/path"
import { decodeBase64, encodeBase64 } from "@std/encoding"

/** Resolve main repo root (not worktree root — .age/ lives there) */
function resolveMainRepoRoot(): string {
  // git rev-parse --git-common-dir returns .git path (shared across worktrees)
  const cmd = new Deno.Command("git", {
    args: ["rev-parse", "--git-common-dir"],
    stdout: "piped",
    stderr: "piped",
  })
  const { code, stdout } = cmd.outputSync()
  if (code === 0) {
    const gitDir = new TextDecoder().decode(stdout).trim()
    if (gitDir) return dirname(gitDir)
  }
  // Fallback: try to read .git file (worktree pointer)
  try {
    const gitFile = Deno.readTextFileSync(join(Deno.cwd(), ".git")).trim()
    const m = gitFile.match(/^gitdir:\s+(.+)/)
    if (m) {
      return dirname(dirname(m[1]))
    }
  } catch { /* ignore */ }
  return Deno.cwd()
}

const GIT_ROOT = resolveMainRepoRoot()
const ROOT_DIR = Deno.cwd()
const AGE_KEY_FILE = join(GIT_ROOT, ".age", "key.txt")
const AGE64_PREFIX = "age64:"

export interface EncryptionResult {
  success: boolean
  output: string
  error?: string
}

export interface EnvEntry {
  raw: string // original line (preserves comments/blanks)
  key?: string // env var key (undefined for comment/blank)
  value?: string // plaintext value (undefined if encrypted)
  encrypted?: string // age64 ciphertext (undefined if plaintext)
}

/**
 * Get age public key from key file
 */
export function getAgePublicKey(): string {
  const content = Deno.readTextFileSync(AGE_KEY_FILE)
  const match = content.match(/# public key: (.+)/)
  if (!match) throw new Error("Age public key not found in " + AGE_KEY_FILE)
  return match[1].trim()
}

/**
 * Check if age is installed
 */
export async function checkAgeInstalled(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("age", { args: ["--version"] })
    const { code } = await cmd.output()
    return code === 0
  } catch {
    return false
  }
}

/**
 * Encrypt a plaintext value with age, return age64 format
 */
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

/**
 * Decrypt an age64 value
 */
export async function ageDecrypt(age64Value: string): Promise<string> {
  if (!age64Value.startsWith(AGE64_PREFIX)) {
    throw new Error("Not an age64 value: " + age64Value.slice(0, 20))
  }
  const ciphertext = decodeBase64(age64Value.slice(AGE64_PREFIX.length))

  const cmd = new Deno.Command("age", {
    args: ["-d", "-i", AGE_KEY_FILE, "-o", "-"],
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

/**
 * Check if a value is age64-encrypted
 */
export function isAge64(value: string): boolean {
  return value.startsWith(AGE64_PREFIX)
}

/**
 * Parse an env file line by line, preserving structure
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
    // Strip quotes if present
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

/**
 * Parse env file into {key: value} dict (plaintext, decrypting age64)
 */
export async function parseEnvDict(entries: EnvEntry[]): Promise<Record<string, string>> {
  const dict: Record<string, string> = {}
  for (const entry of entries) {
    if (!entry.key) continue
    if (entry.encrypted) {
      dict[entry.key] = await ageDecrypt(entry.encrypted)
    } else if (entry.value !== undefined) {
      dict[entry.key] = entry.value
    }
  }
  return dict
}

/**
 * Find all .env files (not .example, not .age).
 * Matches .env, .env.root, servers/subdir/.env, etc.
 */
export async function findEnvFiles(): Promise<string[]> {
  const envFiles: string[] = []
  for await (const entry of Deno.readDir(ROOT_DIR)) {
    const path = join(ROOT_DIR, entry.name)
    if (entry.isDirectory) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      await walkEnvDir(path, envFiles)
    } else if (
      entry.name.startsWith(".env") &&
      !entry.name.includes(".example") &&
      !entry.name.includes(".sops-backup") &&
      !entry.name.endsWith(".age")
    ) {
      envFiles.push(path)
    }
  }
  return envFiles.sort()
}

async function walkEnvDir(dir: string, results: string[]) {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      await walkEnvDir(path, results)
    } else if (
      entry.name.startsWith(".env") &&
      !entry.name.includes(".example") &&
      !entry.name.includes(".sops-backup") &&
      !entry.name.endsWith(".age") &&
      !path.includes(".git") &&
      !path.includes("node_modules")
    ) {
      results.push(path)
    }
  }
}

/**
 * Find corresponding .env.age file for a .env file
 */
export function getEnvAgePath(envPath: string): string {
  return envPath + ".age"
}

/**
 * Reconstruct env file content from entries
 */
export function serializeEnv(entries: EnvEntry[]): string {
  return entries.map((e) => e.raw).join("\n")
}

/**
 * Get relative path from repo root
 */
export function getRelativePath(fullPath: string): string {
  return fullPath.replace(ROOT_DIR + "/", "")
}
