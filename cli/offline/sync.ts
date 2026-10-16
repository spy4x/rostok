// Copying with rsync: local folders → drive (backup) and back (restore),
// plus the guard that keeps `rsync --delete` from silently removing
// repositories that exist only on the drive.

import { join } from "@std/path"
import { UserError } from "../errors.ts"
import type { OfflineDeps, Reporter } from "./context.ts"
import { expandHome } from "./settings.ts"
import type { BackupPath } from "./types.ts"

/** What rsync leaves out of a backup. It also never deletes these on the drive. */
export const RSYNC_EXCLUDES = [".sync*", "*.tmp", ".stfolder", ".stversions"]

/** True when `name` matches one of {@link RSYNC_EXCLUDES}. */
function isExcluded(name: string): boolean {
  return RSYNC_EXCLUDES.some((pattern) => {
    if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1))
    if (pattern.startsWith("*")) return name.endsWith(pattern.slice(1))
    return name === pattern
  })
}

export interface DriveOnlyRepos {
  target: string
  repos: string[]
}

/**
 * The folders that exist on the drive under each target but not in its
 * local source: `rsync --delete` would remove them. A target that is not
 * on the drive yet has none.
 */
export async function findDriveOnlyRepos(
  backupPaths: BackupPath[],
  mountPoint: string,
  home: string,
): Promise<DriveOnlyRepos[]> {
  const found: DriveOnlyRepos[] = []
  for (const bp of backupPaths) {
    const local = new Set<string>()
    for await (const entry of Deno.readDir(expandHome(bp.source, home))) {
      if (entry.isDirectory) local.add(entry.name)
    }
    const repos: string[] = []
    try {
      for await (const entry of Deno.readDir(join(mountPoint, bp.target))) {
        if (entry.isDirectory && !local.has(entry.name) && !isExcluded(entry.name)) {
          repos.push(entry.name)
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error
    }
    if (repos.length > 0) found.push({ target: bp.target, repos: repos.sort() })
  }
  return found
}

/**
 * Lets the copy go ahead only when the drive-only repositories may be
 * deleted: `--delete-missing`, or a "yes" at a terminal (default no).
 * Otherwise throws, before anything is copied, naming the flag.
 */
export async function confirmDeleteMissing(
  deps: OfflineDeps,
  out: Reporter,
  found: DriveOnlyRepos[],
  deleteMissing: boolean,
  interactive: boolean,
): Promise<void> {
  if (found.length === 0) return
  out.line("These repositories are on the drive but no longer local; the copy deletes them:")
  for (const { target, repos } of found) {
    for (const repo of repos) out.line(`   ${target}/${repo}`)
  }
  if (deleteMissing) return
  if (interactive) {
    const yes = await deps.confirmFn({ message: "Delete them from the drive?", default: false })
    if (yes) return
    throw new UserError("stopped before copying; the drive is unchanged")
  }
  throw new UserError(
    "stopped before copying: repositories on the drive would be deleted. " +
      "Pass --delete-missing to allow it.",
  )
}

/**
 * Turns rsync `--info=progress2` output into a line every 5%. Returns a
 * function that takes each stdout chunk and gives back the lines to print.
 */
export function progressReporter(): (chunk: string) => string[] {
  let last = 0
  let pending = ""
  return (chunk) => {
    const lines: string[] = []
    const parts = (pending + chunk).split(/[\r\n]/)
    pending = parts.pop() ?? ""
    for (const line of parts) {
      const match = line.match(/(\d+)%/)
      if (!match) continue
      const progress = parseInt(match[1])
      if (progress < last + 5) continue
      const size = line.match(/([\d.,]+[KMGT]?)/)
      const speed = line.match(/([\d.,]+[KMGT]?B\/s)/)
      let msg = `   ${progress}%`
      if (size) msg += ` (${size[1]})`
      if (speed) msg += ` @ ${speed[1]}`
      lines.push(msg)
      last = progress
    }
    return lines
  }
}

/** Runs one rsync, printing progress, and throws a UserError naming `what` on failure. */
async function rsync(
  deps: OfflineDeps,
  out: Reporter,
  args: string[],
  what: string,
): Promise<void> {
  const progress = progressReporter()
  const result = await deps.runner.stream(
    ["rsync", "-ah", "--info=progress2", "--delete", ...args],
    (chunk) => {
      for (const line of progress(chunk)) out.line(line)
    },
  )
  if (!result.success) {
    throw new UserError(`rsync failed for ${what}: ${result.error.trim() || "no error output"}`)
  }
}

/** Copies every backup path to its target on the drive. */
export async function syncToDrive(
  deps: OfflineDeps,
  out: Reporter,
  backupPaths: BackupPath[],
  mountPoint: string,
): Promise<void> {
  for (const bp of backupPaths) {
    out.line(`   ${bp.source} → ${bp.target}`)
    await rsync(
      deps,
      out,
      [
        ...RSYNC_EXCLUDES.map((e) => `--exclude=${e}`),
        `${expandHome(bp.source, deps.home)}/`,
        `${join(mountPoint, bp.target)}/`,
      ],
      bp.target,
    )
  }
}

/** Copies every target on the drive back to its local source, replacing what is there. */
export async function syncFromDrive(
  deps: OfflineDeps,
  out: Reporter,
  backupPaths: BackupPath[],
  mountPoint: string,
): Promise<void> {
  for (const bp of backupPaths) {
    const local = expandHome(bp.source, deps.home)
    out.line(`   ${bp.target} → ${local}`)
    await Deno.mkdir(local, { recursive: true })
    await rsync(deps, out, [`${join(mountPoint, bp.target)}/`, `${local}/`], bp.target)
  }
}
