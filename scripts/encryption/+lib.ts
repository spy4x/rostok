#!/usr/bin/env deno run --allow-read --allow-write --allow-run

/**
 * Shared encryption utilities using sops and age
 * LEGACY — kept for migration. New encryption uses age64 (see age-lib.ts).
 * Single .age/key.txt in root for ALL .env* files
 */

import { join } from "@std/path"
import { exists } from "@std/fs"
import { walk } from "@std/fs"

export interface EncryptionResult {
  success: boolean
  output: string
  error?: string
}

const ROOT_DIR = Deno.cwd()
const AGE_KEY_FILE = join(ROOT_DIR, ".age", "key.txt")

/**
 * Check if sops and age are installed
 */
export async function checkDependencies(): Promise<{ sops: boolean; age: boolean }> {
  const checkCommand = async (cmd: string): Promise<boolean> => {
    try {
      const command = new Deno.Command(cmd, { args: ["--version"] })
      const { code } = await command.output()
      return code === 0
    } catch {
      return false
    }
  }

  return {
    sops: await checkCommand("sops"),
    age: await checkCommand("age-keygen"),
  }
}

/**
 * Find all .env* files (except .example and .age variants)
 * Includes: .env, .env.root, .env.prod, .env.stag, servers/.env, etc.
 */
export async function findEnvFiles(): Promise<string[]> {
  const envFiles: string[] = []

  for await (
    const entry of walk(ROOT_DIR, {
      maxDepth: 5,
      includeDirs: false,
      followSymlinks: false,
    })
  ) {
    const relativePath = entry.path.replace(ROOT_DIR + "/", "")

    // Skip excluded directories
    if (
      relativePath.includes("node_modules") ||
      relativePath.includes(".git") ||
      relativePath.includes("dist") ||
      relativePath.includes("build")
    ) {
      continue
    }

    // Match .env* files but exclude .example, .age, .backup, and .json
    if (
      entry.name.startsWith(".env") &&
      !entry.name.includes(".example") &&
      !entry.name.endsWith(".age") &&
      !entry.name.endsWith(".backup") &&
      !entry.name.endsWith(".json")
    ) {
      envFiles.push(entry.path)
    }
  }

  return envFiles.sort()
}

/**
 * Find all .env*.age files to decrypt
 */
export async function findEncryptedFiles(): Promise<string[]> {
  const encryptedFiles: string[] = []

  for await (
    const entry of walk(ROOT_DIR, {
      maxDepth: 5,
      includeDirs: false,
      followSymlinks: false,
    })
  ) {
    const relativePath = entry.path.replace(ROOT_DIR + "/", "")

    // Skip excluded directories
    if (
      relativePath.includes("node_modules") ||
      relativePath.includes(".git") ||
      relativePath.includes("dist") ||
      relativePath.includes("build")
    ) {
      continue
    }

    // Match .env*.age files
    if (entry.name.startsWith(".env") && entry.name.endsWith(".age")) {
      encryptedFiles.push(entry.path)
    }
  }

  return encryptedFiles.sort()
}

/**
 * Encrypt a single .env file using sops
 */
export async function encryptFile(filePath: string): Promise<EncryptionResult> {
  try {
    if (!(await exists(filePath))) {
      return {
        success: false,
        output: "",
        error: "File not found",
      }
    }

    const encryptedPath = filePath + ".age"

    const command = new Deno.Command("sops", {
      args: [
        "--encrypt",
        "--input-type",
        "dotenv",
        "--output-type",
        "dotenv",
        "--output",
        encryptedPath,
        filePath,
      ],
      cwd: ROOT_DIR,
      env: {
        SOPS_AGE_KEY_FILE: AGE_KEY_FILE,
      },
    })

    const { code, stdout, stderr } = await command.output()

    if (code !== 0) {
      return {
        success: false,
        output: new TextDecoder().decode(stdout),
        error: new TextDecoder().decode(stderr),
      }
    }

    return {
      success: true,
      output: `Encrypted to ${encryptedPath}`,
    }
  } catch (error) {
    return {
      success: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Decrypt a single .env.age file using sops
 */
export async function decryptFile(filePath: string): Promise<EncryptionResult> {
  try {
    if (!(await exists(filePath))) {
      return {
        success: false,
        output: "",
        error: "Encrypted file not found",
      }
    }

    // Remove .age extension to get output path
    const decryptedPath = filePath.replace(/\.age$/, "")

    const command = new Deno.Command("sops", {
      args: [
        "--decrypt",
        "--input-type",
        "dotenv",
        "--output-type",
        "dotenv",
        "--output",
        decryptedPath,
        filePath,
      ],
      cwd: ROOT_DIR,
      env: {
        SOPS_AGE_KEY_FILE: AGE_KEY_FILE,
      },
    })

    const { code, stdout, stderr } = await command.output()

    if (code !== 0) {
      return {
        success: false,
        output: new TextDecoder().decode(stdout),
        error: new TextDecoder().decode(stderr),
      }
    }

    return {
      success: true,
      output: `Decrypted to ${decryptedPath}`,
    }
  } catch (error) {
    return {
      success: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Get relative path from root for display
 */
export function getRelativePath(fullPath: string): string {
  return fullPath.replace(ROOT_DIR + "/", "")
}
