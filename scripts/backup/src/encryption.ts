import { dirname, join } from "@std/path"
import { exists } from "@std/fs"

/**
 * Decrypt environment file before running backups using age64.
 * Falls back to legacy SOPS if age64 fails.
 */
export async function ensureDecryptedEnv(serverPath: string): Promise<boolean> {
  const envFile = join(serverPath, ".env")
  const encryptedFile = join(serverPath, ".env.age")

  // If .env exists, we're good
  if (await exists(envFile)) {
    return true
  }

  // If .env.age exists, try to decrypt it
  if (await exists(encryptedFile)) {
    return await decryptAge64File(encryptedFile, envFile)
  }

  return false
}

/**
 * Decrypt a single .env.age file using age64
 */
async function decryptAge64File(agePath: string, outPath: string): Promise<boolean> {
  try {
    const content = Deno.readTextFileSync(agePath)
    const lines = content.split("\n")
    const result: string[] = []

    // Resolve .age/key.txt from git root
    const gitRoot = await resolveGitRoot()
    const ageKeyFile = join(gitRoot, ".age", "key.txt")

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) {
        result.push(line)
        continue
      }
      const eqIdx = line.indexOf("=")
      if (eqIdx === -1) {
        result.push(line)
        continue
      }
      const key = line.slice(0, eqIdx).trim()
      let value = line.slice(eqIdx + 1)

      // Strip quotes
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }

      if (value.startsWith("age64:")) {
        // Decrypt age64 value
        const base64 = value.slice(6)
        const ciphertext = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))

        const cmd = new Deno.Command("age", {
          args: ["-d", "-i", ageKeyFile, "-o", "-"],
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
          console.error(`Failed to decrypt ${key}: ${new TextDecoder().decode(output.stderr)}`)
          result.push(line) // keep encrypted line on failure
        } else {
          const decrypted = new TextDecoder().decode(output.stdout).trim()
          result.push(`${key}=${decrypted}`)
        }
      } else {
        result.push(line)
      }
    }

    Deno.writeTextFileSync(outPath, result.join("\n") + "\n")
    console.log(`✓ Decrypted .env.age to .env for ${dirname(agePath)}`)
    return true
  } catch (error) {
    console.error(`Failed to decrypt .env.age:`, error)
    return false
  }
}

/**
 * Resolve main repo root (handles worktrees)
 */
async function resolveGitRoot(): Promise<string> {
  try {
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
  } catch { /* ignore */ }
  try {
    const gitFile = Deno.readTextFileSync(join(Deno.cwd(), ".git")).trim()
    const m = gitFile.match(/^gitdir:\s+(.+)/)
    if (m) return dirname(dirname(m[1]))
  } catch { /* ignore */ }
  return Deno.cwd()
}

/**
 * Check if server has encrypted environment
 */
export async function hasEncryptedEnv(serverPath: string): Promise<boolean> {
  return await exists(join(serverPath, ".env.age"))
}

/**
 * Clean up decrypted .env file after backup (optional)
 */
export async function cleanupDecryptedEnv(serverPath: string): Promise<void> {
  const envFile = join(serverPath, ".env")
  const encryptedFile = join(serverPath, ".env.age")

  if (await exists(encryptedFile) && await exists(envFile)) {
    try {
      await Deno.remove(envFile)
      console.log(`Cleaned up decrypted .env file for ${serverPath}`)
    } catch (error) {
      console.error(`Failed to clean up .env for ${serverPath}:`, error)
    }
  }
}
