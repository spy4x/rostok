// `rostok offline restore`: copy the drive's repositories back over the
// local folders, then check the restored copies.

import { UserError } from "../errors.ts"
import {
  assertLinux,
  type DriveOptions,
  isInteractive,
  openBackupDrive,
  requireTools,
  targetsOnDrive,
} from "./common.ts"
import { type OfflineDeps, Reporter } from "./context.ts"
import { describeRelease, ensureMounted, release, type ReleaseResult } from "./mount.ts"
import { classifyBackupOutcome, exitCodeFor, formatOutcomeBanner } from "./outcome.ts"
import { expandHome, loadSettings } from "./settings.ts"
import { describeChecks, summaryLines } from "./summary.ts"
import { syncFromDrive } from "./sync.ts"
import { verifyRepos } from "./verify.ts"

export interface RestoreOptions extends DriveOptions {
  overwriteLocal: boolean
  eject: boolean
}

/**
 * Runs `rostok offline restore`. Replacing the local folders needs
 * `--overwrite-local`, or the disk name typed at a terminal; `-n` alone
 * never confirms it, and without a terminal the missing flag stops the
 * run before the drive is touched.
 */
export async function runRestore(deps: OfflineDeps, opts: RestoreOptions): Promise<void> {
  assertLinux(deps)
  const interactive = isInteractive(deps, opts.nonInteractive)
  const settings = await loadSettings(deps.cwd)
  const locals = settings.backupPaths.map((bp) => expandHome(bp.source, deps.home))
  if (!interactive && !opts.overwriteLocal) {
    throw new UserError(
      `restore replaces ${locals.join(", ")} with the drive's copy: ` +
        `pass --overwrite-local to allow it`,
    )
  }
  const out = new Reporter(deps)
  const startedAt = deps.now()
  const { disk, partition } = await openBackupDrive(deps, out, opts.drive, interactive)
  await requireTools(deps, [
    "rsync",
    "restic",
    ...(partition.mountpoints.length > 0 ? [] : ["udisksctl"]),
  ])

  const mounted = await ensureMounted(deps, out, partition)
  let released: ReleaseResult
  let failed = false
  try {
    const found = await targetsOnDrive(out, settings.backupPaths, mounted.path)
    out.line("Restore replaces these local folders with the drive's copy:")
    for (const bp of found) out.line(`   ${bp.target}/ → ${expandHome(bp.source, deps.home)}`)
    if (!opts.overwriteLocal) {
      const typed = await deps.promptFn(
        { message: `Type the disk name (${disk.name}) to replace them` },
        false,
      )
      if (typed.trim().replace(/^\/dev\//, "") !== disk.name) {
        throw new UserError("restore cancelled; nothing was changed")
      }
    }

    await out.step(
      "Copy from the drive (rsync)",
      () => syncFromDrive(deps, out, found, mounted.path),
    )
    const results = await out.step(
      "Check the restored repositories (restic check, fast)",
      () =>
        verifyRepos(
          deps,
          out,
          found.map((bp) => ({ name: bp.target, path: expandHome(bp.source, deps.home) })),
          settings.password,
          false,
        ),
    )
    const outcome = classifyBackupOutcome(true, true, results)
    failed = exitCodeFor(outcome) !== 0
    for (const line of formatOutcomeBanner(outcome, results, "Restore")) out.line(line)
    for (
      const line of summaryLines([
        ["Restored", found.map((bp) => expandHome(bp.source, deps.home)).join(", ")],
        ["Checks", describeChecks(results)],
      ], deps.now() - startedAt)
    ) out.line(line)
  } finally {
    released = await release(deps, out, disk, partition, mounted, opts.eject)
  }
  out.line(`  Drive: ${describeRelease(released)}`)
  if (failed) throw new UserError("the restored repositories failed their check; see above")
}
