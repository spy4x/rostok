// `rostok offline verify`: check the copies already on the drive, without
// copying anything.

import { join } from "@std/path"
import { formatBytes } from "@spy4x/platform/universal/format-number"
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
import { loadSettings } from "./settings.ts"
import { describeChecks, driveSpace, summaryLines } from "./summary.ts"
import type { SmartMode } from "./types.ts"
import { getSize, runSmartCheck, type SmartResult, verifyRepos } from "./verify.ts"

export interface VerifyOptions extends DriveOptions {
  check: "fast" | "full"
  smart: SmartMode
  eject: boolean
}

/**
 * Runs `rostok offline verify`.
 *
 * @throws UserError for anything the operator can fix, and for a run
 *   whose checks failed or proved nothing (after the summary and eject).
 */
export async function runVerify(deps: OfflineDeps, opts: VerifyOptions): Promise<void> {
  assertLinux(deps)
  const interactive = isInteractive(deps, opts.nonInteractive)
  const settings = await loadSettings(deps.cwd)
  const out = new Reporter(deps)
  const startedAt = deps.now()
  const { disk, partition } = await openBackupDrive(deps, out, opts.drive, interactive)
  await requireTools(deps, [
    "restic",
    ...(partition.mountpoints.length > 0 ? [] : ["udisksctl"]),
  ])

  const mounted = await ensureMounted(deps, out, partition)
  let released: ReleaseResult
  let failed = false
  try {
    const found = await targetsOnDrive(out, settings.backupPaths, mounted.path)
    let total = 0
    for (const bp of found) {
      const size = await getSize(deps, join(mounted.path, bp.target))
      total += size.bytes
      out.line(`   ${bp.target}: ${size.human}`)
    }

    const results = await out.step(
      `Check repositories (restic check, ${opts.check})`,
      () =>
        verifyRepos(
          deps,
          out,
          found.map((bp) => ({ name: bp.target, path: join(mounted.path, bp.target) })),
          settings.password,
          opts.check === "full",
        ),
    )

    let smart: SmartResult = { status: "skipped", summary: "skipped (--smart skip)", details: "" }
    if (opts.smart !== "skip") {
      const type = opts.smart
      smart = await out.step(
        `SMART ${type} test`,
        () => runSmartCheck(deps, out, `/dev/${disk.name}`, type, interactive),
      )
    }

    const outcome = classifyBackupOutcome(true, true, results)
    failed = exitCodeFor(outcome) !== 0
    for (const line of formatOutcomeBanner(outcome, results, "Verification")) out.line(line)
    for (
      const line of summaryLines([
        ["Checked", `${found.length} folder(s), ${formatBytes(total)} on the drive`],
        ["Checks", describeChecks(results)],
        ["SMART", smart.summary],
        ["Space", await driveSpace(deps, mounted.path)],
      ], deps.now() - startedAt)
    ) out.line(line)
  } finally {
    released = await release(deps, out, disk, partition, mounted, opts.eject)
  }
  out.line(`  Drive: ${describeRelease(released)}`)
  if (failed) throw new UserError("the verification failed; see the summary above")
}
