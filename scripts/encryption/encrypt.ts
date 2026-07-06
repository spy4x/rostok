#!/usr/bin/env deno run --allow-read --allow-write --allow-run

/**
 * Encrypt all .env* files to .env*.age
 * LEGACY SOPS — kept for migration. Use `deno task env:encrypt` for age64.
 * Uses single .age/key.txt in root for ALL .env* files
 */

import { checkDependencies, encryptFile, findEnvFiles, getRelativePath } from "./+lib.ts"

async function main() {
  console.log("🔐 Encrypting environment files...")

  // Check dependencies
  const deps = await checkDependencies()
  if (!deps.sops || !deps.age) {
    console.error("❌ Missing required dependencies:")
    if (!deps.sops) {
      console.error("   - sops: Install with 'sudo apt install sops' or 'brew install sops'")
    }
    if (!deps.age) {
      console.error("   - age: Install with 'sudo apt install age' or 'brew install age'")
    }
    Deno.exit(1)
  }

  // Find all .env files
  const envFiles = await findEnvFiles()

  if (envFiles.length === 0) {
    console.log("ℹ️  No .env files found to encrypt")
    Deno.exit(0)
  }

  console.log(`Found ${envFiles.length} file(s) to encrypt:\n`)

  let successCount = 0
  let failCount = 0

  // Encrypt each file
  for (const filePath of envFiles) {
    const relativePath = getRelativePath(filePath)
    console.log(`   📄 ${relativePath}`)

    const result = await encryptFile(filePath)

    if (result.success) {
      console.log(`      ✅ Encrypted to ${relativePath}.age`)

      // Add encrypted file to git
      const addResult = await new Deno.Command("git", {
        args: ["add", `${filePath}.age`],
        stdout: "piped",
        stderr: "piped",
      }).output()

      if (addResult.code === 0) {
        console.log(`      📝 Added to git: ${relativePath}.age`)
      } else {
        console.error(
          `      ⚠️  Failed to add to git: ${new TextDecoder().decode(addResult.stderr)}`,
        )
      }

      successCount++
    } else {
      console.error(`      ❌ Failed: ${result.error}`)
      failCount++
    }
  }

  console.log(
    `\n${successCount > 0 ? "✅" : "❌"} Encrypted ${successCount}/${envFiles.length} file(s)${
      failCount > 0 ? ` (${failCount} failed)` : ""
    }`,
  )

  if (failCount > 0) {
    Deno.exit(1)
  }
}

if (import.meta.main) {
  await main()
}
