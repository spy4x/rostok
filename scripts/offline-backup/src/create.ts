import { runCommand } from "../../+lib.ts"
import type { BackupPath, VerifyResults } from "./types.ts"
import {
  checkDriveExists,
  createBackupStructure,
  ejectDrive,
  formatDrive,
  getMountPoint,
  isMounted,
  listDrives,
  mountDrive,
  unmountDrive,
} from "./drive.ts"
import { checkDeletedRepos, syncBackups } from "./sync.ts"
import { getBackupSize, runSmartCheck, verifyBackups } from "./verify.ts"
import { ConsoleLogger, parseBackupPaths, saveBackupLog, writeReadme } from "./helpers.ts"

export async function create(envVars: Record<string, string>): Promise<void> {
  const backupPathsJson = envVars.BACKUP_PATHS
  const resticPassword = envVars.BACKUPS_PASSWORD

  let backupPaths: BackupPath[]
  try {
    backupPaths = parseBackupPaths(backupPathsJson)
  } catch (error) {
    console.error(`❌ Error: ${error}`)
    console.error(`   Expected JSON array: [{"source":"~/path","target":"folder-name"}]`)
    Deno.exit(1)
  }

  const logger = new ConsoleLogger()
  logger.start()

  const timings: Record<string, { start: number; end?: number; duration?: number }> = {}
  let syncSuccess = false
  let smartTestRun = false
  let smartTestType = ""
  let smartTestResults = ""
  let MOUNT_POINT = ""
  let partition = ""
  let device = ""
  let verifyResults: VerifyResults = {
    passed: 0,
    failed: 0,
    skipped: 0,
    details: [],
  }

  const startTiming = (step: string) => {
    timings[step] = { start: Date.now() }
    console.log(`⏱️  Starting: ${step}`)
  }

  const endTiming = (step: string) => {
    if (timings[step]) {
      timings[step].end = Date.now()
      timings[step].duration = timings[step].end! - timings[step].start
      const durationSec = Math.round(timings[step].duration! / 1000)
      const mins = Math.floor(durationSec / 60)
      const secs = durationSec % 60
      console.log(`✅ Completed: ${step} (${mins}m ${secs}s)`)
    }
  }

  timings.total = { start: Date.now() }
  console.log("=== Offline Backup Session Started ===")

  for (const backupPath of backupPaths) {
    const expanded = backupPath.source.replace(/^~/, Deno.env.get("HOME") || "~")
    try {
      const stat = await Deno.stat(expanded)
      if (!stat.isDirectory) {
        console.error(`❌ Error: ${expanded} is not a directory`)
        logger.stop()
        Deno.exit(1)
      }
    } catch {
      console.error(`❌ Error: ${expanded} does not exist`)
      logger.stop()
      Deno.exit(1)
    }
  }

  console.log("\n=== Offline Backup - Create Mode ===\n")
  console.log("📦 Backup Paths:")
  backupPaths.forEach((bp) => {
    console.log(`   ${bp.source} → ${bp.target}`)
  })
  console.log("")
  console.log("⚠️  This script will require sudo password for the following operations:")
  console.log("   - Setting write permissions on mounted drive")
  console.log("   - Formatting drive (if selected)")
  console.log("   - Running SMART health checks (if selected)")
  console.log("")

  console.log("📋 Available drives:\n")
  const drives = await listDrives()

  if (drives.length === 0) {
    console.error("❌ No drives found")
    logger.stop()
    Deno.exit(1)
  }

  drives.forEach((d, i) => {
    console.log(`  ${i + 1}. ${d.name} - ${d.size} - ${d.model}`)
  })

  const driveInput = prompt("\n🔍 Enter drive name (e.g., 'sda'): ")
  if (!driveInput) {
    console.log("❌ No drive selected")
    logger.stop()
    Deno.exit(0)
  }

  const driveName = driveInput.trim()
  device = `/dev/${driveName}`
  partition = `${device}1`

  if (!(await checkDriveExists(driveName))) {
    console.error(`❌ Error: Drive ${device} does not exist`)
    logger.stop()
    Deno.exit(1)
  }

  const needsFormat = prompt(
    "\n❓ Does this drive need formatting? (yes/no) [no]: ",
  )

  console.log("\n🔍 Backup Verification")
  console.log("   fast: ~2-5 minutes  - Check repository structure only")
  console.log("   full: ~hours - Read and verify every byte (thorough)")
  console.log("   skip: Skip verification")
  const verifyChoice = prompt(
    "\n❓ Verification type? (fast/full/skip) [fast]: ",
  ) || "fast"
  const fullVerification = verifyChoice.toLowerCase() === "full"
  const skipVerification = verifyChoice.toLowerCase() === "skip"

  console.log("\n🔍 Drive Health Check (SMART)")
  console.log("   short: ~2 minutes  - Quick electrical/mechanical check")
  console.log("   long:  ~390 minutes - Comprehensive surface scan")
  console.log("   skip:  Skip health check")
  const smartChoice = prompt(
    "\n❓ SMART check type? (short/long/skip) [short]: ",
  ) || "short"

  console.log("\n✅ All questions answered! Starting backup process...")
  console.log("   You can now take a walk - the backup will run unattended.\n")
  if (needsFormat?.toLowerCase() === "yes") {
    await formatDrive(device)
  }

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

    await createBackupStructure(MOUNT_POINT, backupPaths)

    if (!(await checkDeletedRepos(backupPaths, MOUNT_POINT))) {
      console.log("❌ Operation cancelled")
      await unmountDrive(partition, MOUNT_POINT)
      await ejectDrive(device)
      logger.stop()
      Deno.exit(0)
    }

    startTiming("rsync")
    await syncBackups(backupPaths, MOUNT_POINT)
    syncSuccess = true
    endTiming("rsync")

    if (!skipVerification) {
      startTiming("verification")
      verifyResults = await verifyBackups(
        MOUNT_POINT,
        backupPaths,
        resticPassword,
        fullVerification,
      )
      endTiming("verification")
    } else {
      console.log("\n⏭️  Skipping backup verification")
    }

    startTiming("readme")
    await writeReadme(MOUNT_POINT, backupPaths)
    endTiming("readme")

    if (smartChoice.toLowerCase() === "short" || smartChoice.toLowerCase() === "long") {
      smartTestRun = true
      smartTestType = smartChoice.toLowerCase()
      startTiming("smart_check")
      smartTestResults = await runSmartCheck(device, smartChoice.toLowerCase() as "short" | "long")
      endTiming("smart_check")
    } else {
      console.log("\n⏭️  Skipping SMART check")
    }

    timings.total.end = Date.now()
    timings.total.duration = timings.total.end - timings.total.start
    const totalDuration = Math.round(timings.total.duration / 1000)

    console.log("\n" + "=".repeat(60))
    console.log("📊 BACKUP SUMMARY")
    console.log("=".repeat(60))
    console.log(`\n✅ Backup completed successfully!`)
    console.log(`   Total Duration: ${Math.floor(totalDuration / 60)}m ${totalDuration % 60}s`)
    if (timings.rsync?.duration) {
      const rsyncSec = Math.round(timings.rsync.duration / 1000)
      console.log(`   - Rsync: ${Math.floor(rsyncSec / 60)}m ${rsyncSec % 60}s`)
    }
    if (timings.verification?.duration) {
      const verifySec = Math.round(timings.verification.duration / 1000)
      console.log(`   - Verification: ${Math.floor(verifySec / 60)}m ${verifySec % 60}s`)
    }
    if (timings.smart_check?.duration) {
      const smartSec = Math.round(timings.smart_check.duration / 1000)
      console.log(`   - SMART Check: ${Math.floor(smartSec / 60)}m ${smartSec % 60}s`)
    }
    console.log(`\n   Backup Paths:`)
    backupPaths.forEach((bp) => {
      console.log(`     ${bp.source} → ${bp.target}`)
    })
    console.log(`   Destination: ${MOUNT_POINT}`)
    console.log(`\n📦 Verification Results:`)
    console.log(`   ✅ Passed:  ${verifyResults.passed}`)
    if (verifyResults.failed > 0) {
      console.log(`   ❌ Failed:  ${verifyResults.failed}`)
      verifyResults.details.filter((d) => d.status === "failed").forEach((d) => {
        console.log(`      - ${d.name}: ${d.error || "unknown error"}`)
      })
    }
    if (verifyResults.skipped > 0) {
      console.log(`   ⏭️  Skipped: ${verifyResults.skipped} (not restic repos)`)
    }

    const sizeInfo = await getBackupSize(MOUNT_POINT)
    console.log(`\n💾 Backup Size: ${sizeInfo.human}`)

    const dfOutput = await runCommand(["df", "-h", MOUNT_POINT])
    const usageLine = dfOutput.output.split("\n")[1]
    if (usageLine) {
      const parts = usageLine.trim().split(/\s+/)
      console.log(`   Drive Total: ${parts[1]}`)
      console.log(`   Drive Used:  ${parts[2]} (${parts[4]})`)
      console.log(`   Drive Free:  ${parts[3]}`)
    }

    if (smartTestRun) {
      console.log(`\n🔍 SMART Health Check:`)
      console.log(`   Test Type: ${smartTestType}`)
      if (smartTestResults) {
        console.log(`   Status: Completed (see detailed results above)`)
      } else {
        console.log(`   Status: FAILED — could not start test (check sudo)`)
        console.log(`   Run manually: sudo smartctl -t ${smartTestType} ${device}`)
      }
    } else {
      console.log(`\n⏭️  SMART Health Check: Skipped`)
    }

    console.log("=".repeat(60))

    logger.stop()

    const timingSummary = [
      "",
      "=".repeat(60),
      "=== TIMING SUMMARY ===",
      `Total Duration: ${Math.floor(totalDuration / 60)}m ${totalDuration % 60}s`,
    ]

    if (timings.rsync?.duration) {
      const rsyncSec = Math.round(timings.rsync.duration / 1000)
      timingSummary.push(`Rsync: ${Math.floor(rsyncSec / 60)}m ${rsyncSec % 60}s`)
    }
    if (timings.verification?.duration) {
      const verifySec = Math.round(timings.verification.duration / 1000)
      timingSummary.push(`Verification: ${Math.floor(verifySec / 60)}m ${verifySec % 60}s`)
    }
    if (timings.readme?.duration) {
      const readmeSec = Math.round(timings.readme.duration / 1000)
      timingSummary.push(`README: ${Math.floor(readmeSec / 60)}m ${readmeSec % 60}s`)
    }
    if (timings.smart_check?.duration) {
      const smartSec = Math.round(timings.smart_check.duration / 1000)
      timingSummary.push(
        `SMART Check (${smartTestType}): ${Math.floor(smartSec / 60)}m ${smartSec % 60}s`,
      )
    }

    timingSummary.push("", "=== VERIFICATION DETAILS ===")
    timingSummary.push(`Passed: ${verifyResults.passed}`)
    timingSummary.push(`Failed: ${verifyResults.failed}`)
    timingSummary.push(`Skipped: ${verifyResults.skipped}`)
    verifyResults.details.forEach((d) => {
      const statusIcon = d.status === "passed" ? "✅" : d.status === "failed" ? "❌" : "⏭️"
      timingSummary.push(`  ${statusIcon} ${d.name}: ${d.status}${d.error ? ` - ${d.error}` : ""}`)
    })

    if (smartTestResults) {
      timingSummary.push("", "=== SMART TEST RESULTS ===")
      timingSummary.push(smartTestResults)
    }

    const completeLog = [
      ...logger.getLogs(),
      ...timingSummary,
    ]

    try {
      console.log(`\n💾 Saving backup log...`)
      await saveBackupLog(
        MOUNT_POINT,
        completeLog.join("\n"),
        syncSuccess && verifyResults.failed === 0,
      )
      console.log(`✅ Log saved to drive`)
    } catch (error) {
      console.warn(`⚠️  Could not save log to drive: ${error}`)
      const localLog = `/tmp/offline-backup-${
        new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
      }.log`
      await Deno.writeTextFile(localLog, completeLog.join("\n"))
      console.log(`📝 Log saved locally: ${localLog}`)
    }

    console.log(`\n🔒 Unmounting and ejecting drive...`)
    await unmountDrive(partition, MOUNT_POINT)
    await ejectDrive(device)

    console.log("\n🔔 BACKUP COMPLETE!")
    Deno.stdout.write(new TextEncoder().encode("\x07"))
  } catch (error) {
    console.error(`\n❌ Error during backup: ${error}`)
    logger.stop()

    try {
      if (MOUNT_POINT) {
        const completeLog = logger.getLogs()
        await saveBackupLog(MOUNT_POINT, completeLog.join("\n"), false)
      }
    } catch {
      const localLog = `/tmp/offline-backup-error-${Date.now()}.log`
      await Deno.writeTextFile(localLog, logger.getLogs().join("\n"))
      console.error(`\n📝 Error log saved to: ${localLog}`)
    }

    try {
      if (MOUNT_POINT && partition && device) {
        await unmountDrive(partition, MOUNT_POINT)
        await ejectDrive(device)
      }
    } catch {
      // Ignore cleanup errors
    }

    Deno.exit(1)
  }
}
