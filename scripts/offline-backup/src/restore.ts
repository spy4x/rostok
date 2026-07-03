import { runCommand } from "../../+lib.ts"
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
import { verifyBackups } from "./verify.ts"

export async function restore(envVars: Record<string, string>): Promise<void> {
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

  console.log("\n=== Offline Backup - Restore Mode ===\n")
  console.log("⚠️  This script requires no sudo privileges for mounting")
  console.log("")
  console.log("⚠️  WARNING: This will restore backups from offline drive to:")
  backupPaths.forEach((bp) => {
    const expanded = bp.source.replace(/^~/, Deno.env.get("HOME") || "~")
    console.log(`   ${expanded} ← ${bp.target}`)
  })
  console.log("")

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

    let foundTargets = 0
    for (const bp of backupPaths) {
      const targetDir = `${MOUNT_POINT}/${bp.target}`
      try {
        await Deno.stat(targetDir)
        foundTargets++
      } catch {
        console.warn(`⚠️  Warning: Target directory not found: ${bp.target}`)
      }
    }

    if (foundTargets === 0) {
      console.error(`❌ Error: No backup targets found on this drive`)
      console.error("   This drive may not be an offline backup drive or is corrupted")
      await unmountDrive(partition, MOUNT_POINT)
      await ejectDrive(device)
      Deno.exit(1)
    }

    console.log(`\nℹ️  Found ${foundTargets} of ${backupPaths.length} backup target(s) on drive`)

    try {
      const readmePath = `${MOUNT_POINT}/README.md`
      const readme = await Deno.readTextFile(readmePath)
      console.log("\n📋 Backup Information:\n")
      console.log(readme.split("\n").slice(0, 20).join("\n"))
      console.log("\n...(see README.md for complete info)\n")
    } catch {
      console.log("\nℹ️  No README found\n")
    }

    const confirm = prompt(
      "\n⚠️  Type 'RESTORE' to restore all backups to local folders: ",
    )
    if (confirm !== "RESTORE") {
      console.log("❌ Restore cancelled")
      await unmountDrive(partition, MOUNT_POINT)
      await ejectDrive(device)
      Deno.exit(0)
    }

    for (const bp of backupPaths) {
      const expanded = bp.source.replace(/^~/, Deno.env.get("HOME") || "~")
      const sourceDir = `${MOUNT_POINT}/${bp.target}`

      try {
        await Deno.stat(sourceDir)
      } catch {
        console.log(`\n⏭️  Skipping ${bp.target} (not found on drive)`)
        continue
      }

      await Deno.mkdir(expanded, { recursive: true })

      console.log(`\n🔄 Restoring ${bp.target} to ${expanded}...`)

      const source = `${sourceDir}/`
      const target = `${expanded}/`

      const result = await runCommand(
        [
          "rsync",
          "-avhP",
          "--delete",
          source,
          target,
        ],
      )

      if (!result.success) {
        throw new Error(`Rsync failed for ${bp.target}: ${result.error}`)
      }

      console.log(`✅ ${bp.target} restored`)
    }

    console.log("\n✅ All restores completed")

    console.log("\n🔍 Verifying restored backups...")
    await verifyBackups(MOUNT_POINT, backupPaths, resticPassword)

    console.log("\n✅ Restore completed successfully!")
    console.log("\nBackups restored to:")
    backupPaths.forEach((bp) => {
      const expanded = bp.source.replace(/^~/, Deno.env.get("HOME") || "~")
      console.log(`  - ${expanded}`)
    })
    console.log(`\n🔒 To safely remove drive:`)
    console.log(`  udisksctl unmount -b ${partition}`)
    console.log(`  udisksctl power-off -b ${device}`)

    await unmountDrive(partition, MOUNT_POINT)
    await ejectDrive(device)
  } catch (error) {
    console.error(`\n❌ Error during restore: ${error}`)

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
