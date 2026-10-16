// `rostok offline backup`: copy the restic repositories to the drive,
// check them, write README.md and a log, run a SMART test, eject.

import { formatBytes } from "@spy4x/platform/universal/format-number"
import { join } from "@std/path"
import { UserError } from "../errors.ts"
import {
  assertLinux,
  assertSourcesExist,
  type DriveOptions,
  isInteractive,
  openBackupDrive,
  requireTools,
} from "./common.ts"
import { type OfflineDeps, Reporter } from "./context.ts"
import { logPath, prepareDrive, saveLog, writeReadme } from "./drive-files.ts"
import { describeRelease, ensureMounted, release, type ReleaseResult } from "./mount.ts"
import { classifyBackupOutcome, exitCodeFor, formatOutcomeBanner } from "./outcome.ts"
import { loadSettings } from "./settings.ts"
import { describeChecks, driveSpace, summaryLines } from "./summary.ts"
import { confirmDeleteMissing, findDriveOnlyRepos, syncToDrive } from "./sync.ts"
import type { CheckMode, SmartMode, VerifyResults } from "./types.ts"
import { getSize, runSmartCheck, type SmartResult, verifyRepos } from "./verify.ts"

export interface BackupOptions extends DriveOptions {
  check: CheckMode
  smart: SmartMode
  deleteMissing: boolean
  /** False with `--no-eject`: unmount, but leave the drive powered. */
  eject: boolean
}

/**
 * Runs `rostok offline backup`. Never formats: a drive without an
 * `OfflineBackups` partition is refused with the format command to run.
 *
 * @throws UserError for anything the operator can fix, a refused or
 *   declined confirmation (before anything is copied), and a finished run
 *   whose outcome is not a success (after the summary, the log and the
 *   eject), so the process exits 1.
 */
export async function runBackup(deps: OfflineDeps, opts: BackupOptions): Promise<void> {
  assertLinux(deps)
  const interactive = isInteractive(deps, opts.nonInteractive)
  const settings = await loadSettings(deps.cwd)
  await assertSourcesExist(settings.backupPaths, deps.home)
  const out = new Reporter(deps)
  const startedAt = deps.now()
  const { disk, partition } = await openBackupDrive(deps, out, opts.drive, interactive)
  await requireTools(deps, [
    "rsync",
    ...(opts.check === "skip" ? [] : ["restic"]),
    ...(partition.mountpoints.length > 0 ? [] : ["udisksctl"]),
  ])

  const mounted = await ensureMounted(deps, out, partition)
  let released: ReleaseResult
  let failed = false
  try {
    await prepareDrive(deps, out, mounted.path, settings.backupPaths, interactive)
    const driveOnly = await findDriveOnlyRepos(settings.backupPaths, mounted.path, deps.home)
    await confirmDeleteMissing(deps, out, driveOnly, opts.deleteMissing, interactive)

    await out.step(
      "Copy to the drive (rsync)",
      () => syncToDrive(deps, out, settings.backupPaths, mounted.path),
    )

    let results: VerifyResults | undefined
    if (opts.check === "skip") {
      out.line("Skipped the repository check (--check skip)")
    } else {
      results = await out.step(
        `Check repositories (restic check, ${opts.check})`,
        () =>
          verifyRepos(
            deps,
            out,
            settings.backupPaths.map((bp) => ({
              name: bp.target,
              path: join(mounted.path, bp.target),
            })),
            settings.password,
            opts.check === "full",
          ),
      )
    }

    await out.step("Write README.md", () => writeReadme(deps, mounted.path, settings.backupPaths))

    let smart: SmartResult = { status: "skipped", summary: "skipped (--smart skip)", details: "" }
    if (opts.smart !== "skip") {
      const type = opts.smart
      smart = await out.step(
        `SMART ${type} test`,
        () => runSmartCheck(deps, out, `/dev/${disk.name}`, type, interactive),
      )
    }

    const verified = results ?? { passed: 0, failed: 0, skipped: 0, details: [] }
    const outcome = classifyBackupOutcome(true, opts.check !== "skip", verified)
    failed = exitCodeFor(outcome) !== 0
    let copied = 0
    for (const bp of settings.backupPaths) {
      copied += (await getSize(deps, join(mounted.path, bp.target))).bytes
    }
    const log = logPath(mounted.path, startedAt, !failed)
    for (const line of formatOutcomeBanner(outcome, verified, "Backup")) out.line(line)
    for (
      const line of summaryLines([
        ["Copied", `${settings.backupPaths.length} folder(s), ${formatBytes(copied)} on the drive`],
        ["Checks", describeChecks(results)],
        ["SMART", smart.summary],
        ["Space", await driveSpace(deps, mounted.path)],
        ["Log", log],
      ], deps.now() - startedAt)
    ) out.line(line)
    const saved = await saveLog(log, out.log() + (smart.details ? `\n${smart.details}\n` : ""))
    if (saved !== log) out.warn(`Could not write the log to the drive; saved it to ${saved}`)
  } catch (error) {
    failed = true
    const message = error instanceof Error ? error.message : String(error)
    const saved = await saveLog(
      logPath(mounted.path, startedAt, false),
      out.log() + `ERROR: ${message}\n`,
    )
    out.line(`Log: ${saved}`)
    throw error
  } finally {
    released = await release(deps, out, disk, partition, mounted, opts.eject)
  }
  out.line(`  Drive: ${describeRelease(released)}`)
  if (failed) throw new UserError("the backup finished with failures; see the summary above")
}
