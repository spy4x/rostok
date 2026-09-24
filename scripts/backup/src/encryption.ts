import { join } from "@std/path"
import { exists } from "@std/fs"
import { decryptValue, parseEnvFile, readAgeKey } from "@spy4x/server/env-age64"

/**
 * Decrypt environment file before running backups using age64.
 *
 * Bug fixed at extraction time (#242): the previous copy resolved the
 * decryption key against `Deno.cwd()` (the process's own working
 * directory) regardless of which server's `.env.age` it was decrypting.
 * `readAgeKey(serverPath)` resolves the key for THIS server (falling
 * back to the main checkout's key the same way the module's CLI does),
 * so a caller invoked from any cwd still decrypts with the right key.
 */
export async function ensureDecryptedEnv(serverPath: string): Promise<boolean> {
  const envFile = join(serverPath, ".env")
  const encryptedFile = join(serverPath, ".env.age")

  if (await exists(envFile)) return true

  if (await exists(encryptedFile)) {
    try {
      const key = await readAgeKey(serverPath)
      const content = Deno.readTextFileSync(encryptedFile)
      const entries = parseEnvFile(content)
      const lines: string[] = []

      for (const entry of entries) {
        if (entry.assignment) {
          const { prefix, value } = entry.assignment
          lines.push(`${prefix}${await decryptValue(value, key.identity)}`)
        } else {
          lines.push(entry.raw)
        }
      }

      Deno.writeTextFileSync(envFile, lines.join("\n") + "\n")
      console.log(`✓ Decrypted .env.age to .env for ${serverPath}`)
      return true
    } catch (error) {
      console.error(`Failed to decrypt .env.age:`, error)
      return false
    }
  }

  return false
}

/**
 * Check if server has encrypted environment
 */
export async function hasEncryptedEnv(serverPath: string): Promise<boolean> {
  return await exists(join(serverPath, ".env.age"))
}

/**
 * Clean up initial deno cache (noop — AGENTS.md says keep decrypted .env)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function cleanupDecryptedEnv(_serverPath: string): void {
  // Intentionally noop — deleting .env breaks deploy.
  // AGENTS.md: "NEVER rm decrypted .env files"
}
