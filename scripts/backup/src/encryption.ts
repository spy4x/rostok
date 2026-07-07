import { join } from "@std/path"
import { exists } from "@std/fs"
import { ageDecrypt, parseEnvFile } from "../../encryption/age-lib.ts"

/**
 * Decrypt environment file before running backups using age64.
 */
export async function ensureDecryptedEnv(serverPath: string): Promise<boolean> {
  const envFile = join(serverPath, ".env")
  const encryptedFile = join(serverPath, ".env.age")

  if (await exists(envFile)) return true

  if (await exists(encryptedFile)) {
    try {
      const content = Deno.readTextFileSync(encryptedFile)
      const entries = parseEnvFile(content)
      const lines: string[] = []

      for (const entry of entries) {
        if (entry.key && entry.encrypted) {
          lines.push(`${entry.key}=${await ageDecrypt(entry.encrypted)}`)
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
