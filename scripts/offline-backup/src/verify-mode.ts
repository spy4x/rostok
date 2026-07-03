import type { BackupPath } from "./types.ts"
import {
  listDrives,
  checkDriveExists,
  isMounted,
  getMountPoint,
  mountDrive,
  unmountDrive,
  ejectDrive,
} from "./drive.ts"
import { verifyBackups, getBackupSize, runSmartCheck } from "./verify.ts"

export async function verify(envVars: Record<string, string>): Promise<void> {
  const backupPathsJson = envVars.BACKUP_PATHS
  const resticPassword = envVars.BACKUPS_PASSWORD

  let backupPaths: BackupPath[]
  try {
    backupPaths = JSON.parse(backupPathsJson)
    if (!Array.isArray(backupPaths) || backupPaths.length === 0) {
      throw new Error("BACKUP_PATHS must be a non-empty array")
    }
    for (const bp of backupPaths) {
      if (!bp.source || !bp.target) {
        throw new Error("Each backup path must have 'source' and 'target' properties")
      }
    }
  } catch (error) {
    console.error(`❌ Error: Invalid BACKUP_PATHS format: ${error}`)
    console.error(`   Expected JSON array: [{"source":"~/path","target":"folder-name"}]`)
    Deno.exit(1)
  }

  console.log("\n=== Offline Backup - Verify Mode ===\n")
  console.log("⚠️  This will mount the backup drive, verify all repositories,")
  console.log("   run SMART checks, and then safely unmount.\n")

  console.log("📋 Available drives:\n")
  const drives = await listDrives()

  if (drives.length === 0) {
    console.error("❌ No drives found")
    Deno.exit(1)
  }

  drives.forEach((d, i) => {
    console.log(`  ${i + 1}. ${d.name} - ${d.size} - ${d.model}`)
  })

  const driveInput = prompt("\n🔍 Enter drive name (e.g., 'sda'): ")
  if (!driveInput) {
    console.log("❌ No drive selected")
    Deno.exit(0)
  }

  const driveName = driveInput.trim()
  const device = `/dev/${driveName}`
  const partition = `${device}1`

  if (!(await checkDriveExists(driveName))) {
    console.error(`❌ Error: Drive ${device} does not exist`)
    Deno.exit(1)
  }

  let MOUNT_POINT = ""
  try {
    if (await isMounted(partition)) {
      console.log(`ℹ️  ${partition} is already mounted`)
      const currentMount = await getMountPoint(partition)
      if (currentMount) {
        console.log(`   Current mount point: ${currentMount}`)
        const useExisting = prompt("Use this mount point? (yes/no) [no]: ")
        if (useExisting?.toLowerCase() === "yes") {
          MOUNT_POINT = currentMount
        } else {
          await unmountDrive(partition, currentMount)
          MOUNT_POINT = await mountDrive(partition)
        }
      }
    } else {
      MOUNT_POINT = await mountDrive(partition)
    }

    const foundPaths: BackupPath[] = []
    for (const bp of backupPaths) {
      const targetDir = `${MOUNT_POINT}/${bp.target}`
      try {
        await Deno.stat(targetDir)
        foundPaths.push(bp)
      } catch {
        console.warn(`⚠️  Warning: Target directory not found: ${bp.target}`)
      }
    }

    if (foundPaths.length === 0) {
      console.error(`❌ Error: No backup targets found on this drive`)
      console.error("   This drive may not be an offline backup drive or is corrupted")
      await unmountDrive(partition, MOUNT_POINT)
      await ejectDrive(device)
      Deno.exit(1)
    }

    console.log(
      `\nℹ️  Found ${foundPaths.length} of ${backupPaths.length} backup target(s) on drive`,
    )

    try {
      const readmePath = `${MOUNT_POINT}/README.md`
      const readme = await Deno.readTextFile(readmePath)
      console.log("\n📋 Backup Information:\n")
      console.log(readme.split("\n").slice(0, 20).join("\n"))
      console.log("\n...(see README.md for complete info)\n")
    } catch {
      console.log("\nℹ️  No README found\n")
    }

    console.log("\n📊 Analyzing backup...")
    let totalBytes = 0
    for (const bp of foundPaths) {
      const targetDir = `${MOUNT_POINT}/${bp.target}`
      const sizeInfo = await getBackupSize(targetDir)
      totalBytes += sizeInfo.bytes
      console.log(`   ${bp.target}: ${sizeInfo.human}`)
    }

    const units = ["B", "KB", "MB", "GB", "TB"]
    let size = totalBytes
    let unitIndex = 0
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024
      unitIndex++
    }
    const totalHuman = `${size.toFixed(2)} ${units[unitIndex]}`
    console.log(`💾 Total Backup Size: ${totalHuman}\n`)

    console.log("🔍 Starting full verification (this may take a while)...\n")
    const verifyResults = await verifyBackups(MOUNT_POINT, foundPaths, resticPassword)

    console.log("\n" + "=".repeat(60))
    console.log("📦 VERIFICATION RESULTS")
    console.log("=".repeat(60))
    console.log(`\n✅ Passed:  ${verifyResults.passed}`)
    if (verifyResults.failed > 0) {
      console.log(`❌ Failed:  ${verifyResults.failed}`)
      verifyResults.details.filter((d) => d.status === "failed").forEach((d) => {
        console.log(`   - ${d.name}: ${d.error || "unknown error"}`)
      })
    }
    if (verifyResults.skipped > 0) {
      console.log(`⏭️  Skipped: ${verifyResults.skipped} (not restic repos)`)
    }

    console.log("\n🔍 Drive Health Check (SMART)")
    console.log("   short: ~2 minutes  - Quick electrical/mechanical check")
    console.log("   long:  ~390 minutes - Comprehensive surface scan")
    console.log("   no:    Skip health check")
    const smartChoice = prompt(
      "\n❓ Would you like a SMART check of the drive's health? (short/long/no) [short]: ",
    ) || "short"

    let smartTestResults = ""
    if (smartChoice.toLowerCase() === "short" || smartChoice.toLowerCase() === "long") {
      smartTestResults = await runSmartCheck(device, smartChoice.toLowerCase() as "short" | "long")
    } else {
      console.log("\n⏭️  Skipping SMART check")
    }

    console.log("\n" + "=".repeat(60))
    console.log("📊 VERIFICATION COMPLETE")
    console.log("=".repeat(60))

    if (verifyResults.failed === 0) {
      console.log("\n✅ All checks passed! Backup drive is healthy.")
    } else {
      console.log("\n⚠️  Some verification checks failed. Review the results above.")
    }

    if (smartTestResults) {
      console.log("\n🔍 SMART check completed (see results above)")
    }

    console.log("=".repeat(60))

    console.log("\n🔒 Unmounting and ejecting drive...")
    await unmountDrive(partition, MOUNT_POINT)
    await ejectDrive(device)

    console.log("\n✅ Verification complete. Drive safely ejected.")
  } catch (error) {
    console.error(`\n❌ Error during verification: ${error}`)

    try {
      if (MOUNT_POINT) {
        await unmountDrive(partition, MOUNT_POINT)
        await ejectDrive(device)
      }
    } catch {
      // Ignore cleanup errors
    }

    Deno.exit(1)
  }
}
