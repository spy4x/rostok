import { runCommand } from "../../+lib.ts"
import type { BackupPath, VerifyResults } from "./types.ts"

/**
 * Returns true if the current user can run sudo without a password
 * prompt. Runs `sudo -n true` which fails immediately (no prompt, no
 * hang) when sudo would require authentication. Used to gate the
 * SMART test, which needs sudo and previously hung for ~5 minutes
 * waiting for a password that the offline-backup script could not
 * enter (no TTY for stdin in non-interactive runs).
 */
export async function hasPasswordlessSudo(): Promise<boolean> {
  const result = await runCommand(["-n", "true"], { sudo: true })
  return result.success
}

/**
 * Builds the two-line message printed when the SMART test is skipped
 * because passwordless sudo is unavailable. Extracted so the manual
 * `smartctl` command can be unit-tested for the right `checkType` and
 * device — the whole rest of the skip path is I/O (sudo + smartctl)
 * and only review-tested.
 */
export function formatSmartSkipMessage(
  checkType: "short" | "long",
  device: string,
): string[] {
  return [
    "\n⚠️  SMART test skipped — passwordless sudo is unavailable in this session.",
    `   Run manually with: sudo smartctl -t ${checkType} ${device}`,
  ]
}

export async function getBackupSize(path: string): Promise<{ bytes: number; human: string }> {
  const result = await runCommand(["du", "-sb", path])
  if (!result.success) {
    return { bytes: 0, human: "unknown" }
  }

  const bytes = parseInt(result.output.split("\t")[0])

  const units = ["B", "KB", "MB", "GB", "TB"]
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  const human = `${size.toFixed(2)} ${units[unitIndex]}`

  return { bytes, human }
}

export async function refreshSudo(): Promise<boolean> {
  // Non-interactive preflight. `sudo -n true` exits non-zero immediately
  // when a password would be required, so this never hangs even when the
  // caller has no TTY available.
  return await hasPasswordlessSudo()
}

export async function verifyBackups(
  mountPoint: string,
  backupPaths: BackupPath[],
  resticPassword: string,
  fullVerification = false,
): Promise<VerifyResults> {
  const verificationType = fullVerification
    ? "100% data verification"
    : "structure verification (fast)"
  console.log(`\n🔍 Verifying backup integrity (${verificationType})...`)

  const results: VerifyResults = {
    passed: 0,
    failed: 0,
    skipped: 0,
    details: [],
  }

  const resticCheck = await runCommand(["which", "restic"])
  if (!resticCheck.success) {
    console.log("\n⚠️  WARNING: Restic not found!")
    console.log("   Backup verification is HIGHLY RECOMMENDED for data integrity.")
    console.log("   Install restic: https://restic.net/")
    console.log("   Without verification, corrupted backups may go undetected.")
    const skip = prompt("\n❓ Skip verification anyway? (yes/no) [no]: ")
    if (skip?.toLowerCase() !== "yes") {
      console.log("\n❌ Verification cancelled. Please install restic and try again.")
      throw new Error("Restic verification required but restic not installed")
    }
    return results
  }

  for (const backupPath of backupPaths) {
    const targetDir = `${mountPoint}/${backupPath.target}`

    console.log(`\n  📦 Verifying: ${backupPath.target}`)

    const repos: string[] = []
    try {
      for await (const entry of Deno.readDir(targetDir)) {
        if (entry.isDirectory) {
          const configPath = `${targetDir}/${entry.name}/config`
          try {
            await Deno.stat(configPath)
            repos.push(`${targetDir}/${entry.name}`)
          } catch {
            console.log(`     ⏭️  Skipping ${entry.name} (not a restic repository)`)
            results.skipped++
            results.details.push({ name: `${backupPath.target}/${entry.name}`, status: "skipped" })
          }
        }
      }
    } catch (error) {
      console.warn(`  ⚠️  Warning: Could not list repos in ${backupPath.target}: ${error}`)
      continue
    }

    if (repos.length === 0) {
      console.log(`     ℹ️  No restic repositories found in ${backupPath.target}`)
      continue
    }

    for (const repo of repos) {
      const name = `${backupPath.target}/${repo.split("/").pop() || "unknown"}`
      console.log(`     Checking: ${name}...`)

      const originalPassword = Deno.env.get("RESTIC_PASSWORD")

      let result
      try {
        Deno.env.set("RESTIC_PASSWORD", resticPassword)
        result = await runCommand([
          "restic",
          "-r",
          repo,
          "check",
          ...(fullVerification ? ["--read-data"] : []),
        ])
      } finally {
        if (originalPassword) {
          Deno.env.set("RESTIC_PASSWORD", originalPassword)
        } else {
          Deno.env.delete("RESTIC_PASSWORD")
        }
      }

      if (result.success) {
        console.log(`     ✅ ${name}: OK`)
        results.passed++
        results.details.push({ name, status: "passed" })
      } else {
        console.log(`     ❌ ${name}: FAILED`)
        console.log(`        ${result.error.split("\n")[0]}`)
        results.failed++
        results.details.push({ name, status: "failed", error: result.error.split("\n")[0] })
      }
    }
  }

  // No verdict here: `verifyBackups` only reports what it found, and the
  // caller's summary decides what that means. This line used to be an
  // unconditional "✅ Verification complete" even when the tally was
  // empty, which is the same false green the summary was just fixed for.
  console.log(
    `\n🔍 Verification finished — ${results.passed} passed, ${results.failed} failed, ` +
      `${results.skipped} skipped.`,
  )

  if (results.failed > 0) {
    console.warn(
      `\n⚠️  Warning: ${results.failed} repository verification(s) failed`,
    )
  }

  return results
}

export async function runSmartCheck(
  device: string,
  checkType: "short" | "long",
): Promise<string> {
  console.log(`\n🔍 Running SMART ${checkType} test on ${device}...`)
  console.log("   This will check the drive's health and detect potential issues.")

  const smartctlCheck = await runCommand(["which", "smartctl"])
  if (!smartctlCheck.success) {
    console.log("\n⚠️  smartctl not found!")
    console.log("   Install smartmontools: sudo dnf install smartmontools")
    return ""
  }

  const estimatedMinutes = checkType === "short" ? 2 : 390
  console.log(`   Estimated duration: ~${estimatedMinutes} minutes`)

  // Non-interactive preflight: `sudo -n true` exits non-zero immediately if
  // a password would be required, so we never block on a password prompt
  // when stdin has no TTY. Skip the SMART test cleanly and surface the
  // manual command instead of entering the 4-minute wait loop with no
  // chance of ever getting credentials.
  if (!(await hasPasswordlessSudo())) {
    for (const line of formatSmartSkipMessage(checkType, device)) {
      console.log(line)
    }
    return ""
  }

  const testType = checkType === "short" ? "short" : "long"
  const startResult = await runCommand(
    ["smartctl", "-t", testType, device],
    { sudo: true },
  )

  if (
    startResult.output.includes("Self-test execution status") ||
    startResult.output.includes("has begun") ||
    startResult.output.includes("Testing has begun")
  ) {
    console.log("✅ SMART test started successfully")
  } else {
    console.log("\n⚠️  Warning: Could not start SMART test")
    console.log("   Output:", startResult.output)
    console.log("   Error:", startResult.error)
    return ""
  }

  const initialStatus = await runCommand(["smartctl", "-l", "selftest", device], { sudo: true })
  const initialTestLines =
    initialStatus.output.split("\n").filter((line) => line.match(/^\s*#\s*\d+/)).length

  const checkIntervalMs = 4 * 60 * 1000
  const totalWaitMs = estimatedMinutes * 60 * 1000
  const testStartTime = Date.now()

  console.log("\n⏳ Waiting for test to complete...")

  while (true) {
    const elapsed = Date.now() - testStartTime
    const elapsedMinutes = Math.floor(elapsed / 60000)

    if (!(await refreshSudo())) {
      console.log(
        "\n⚠️  Sudo authentication failed — cannot continue SMART monitoring.",
      )
      console.log("   Resume manually with: sudo smartctl -a " + device)
      break
    }

    const statusResult = await runCommand(["smartctl", "-a", device], { sudo: true })
    const statusOutput = statusResult.output + statusResult.error

    const isRunning = statusOutput.includes("Self-test routine in progress") ||
      statusOutput.includes("% of test remaining")

    if (!isRunning) {
      const currentStatus = await runCommand(["smartctl", "-l", "selftest", device], { sudo: true })
      const currentTestLines = currentStatus.output.split("\n").filter((line) =>
        line.match(/^\s*#\s*\d+/)
      ).length

      const isComplete = currentTestLines > initialTestLines

      if (isComplete) {
        console.log(`\n✅ Test completed after ${elapsedMinutes} minutes`)
        break
      }
    }

    if (isRunning) {
      const percentMatch = statusOutput.match(/(\d+)% of test remaining/)
      const remaining = percentMatch
        ? `${percentMatch[1]}% remaining`
        : `${elapsedMinutes}/${estimatedMinutes} min elapsed`
      console.log(`   [${new Date().toLocaleTimeString()}] Still running... ${remaining}`)
    } else if (elapsed < totalWaitMs) {
      console.log(
        `   [${
          new Date().toLocaleTimeString()
        }] In progress: ${elapsedMinutes}/${estimatedMinutes} min elapsed`,
      )
    }

    if (elapsed > totalWaitMs * 1.5) {
      console.log(
        "\n⚠️  Test taking longer than expected, check manually with: sudo smartctl -a " + device,
      )
      break
    }

    await new Promise((resolve) => setTimeout(resolve, checkIntervalMs))
  }

  console.log("\n📊 SMART Test Results:")
  const resultCmd = await runCommand(["smartctl", "-a", device], { sudo: true })

  let smartResults = ""

  if (resultCmd.success || resultCmd.output) {
    const output = resultCmd.output

    const healthMatch = output.match(/SMART overall-health.*:\s*(.+)/)
    if (healthMatch) {
      const health = healthMatch[1].trim()
      const icon = health.includes("PASSED") ? "✅" : "❌"
      console.log(`   ${icon} Health: ${health}`)
      smartResults += `Overall Health: ${health}\n`
    }

    const testLogStart = output.indexOf("SMART Self-test log")
    if (testLogStart > -1) {
      const lines = output.substring(testLogStart).split("\n")
      console.log("\n   Recent Tests:")
      for (let i = 0; i < Math.min(lines.length, 8); i++) {
        if (lines[i].trim()) {
          console.log("   " + lines[i])
          smartResults += lines[i] + "\n"
        }
      }
    }

    console.log("\n✅ SMART check completed successfully")
  } else {
    console.log("\n⚠️  Could not retrieve SMART results")
    console.log("   Check manually with: sudo smartctl -a " + device)
    smartResults = "Could not retrieve SMART results"
  }

  return smartResults
}
