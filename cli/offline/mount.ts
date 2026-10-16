// Mounting, unmounting and powering off the drive through udisksctl, so
// none of it needs root.

import { UserError } from "../errors.ts"
import type { OfflineDeps, Reporter } from "./context.ts"
import type { BlockDevice } from "./disks.ts"

export interface Mounted {
  /** Where the backup partition is mounted. */
  path: string
  /** False when the partition was mounted before the command: it is then left mounted. */
  mountedByUs: boolean
}

/** Parses `udisksctl mount` output: "Mounted /dev/sda1 at /run/media/me/OfflineBackups". */
export function parseMountOutput(output: string): string | undefined {
  const match = output.match(/ at (.+?)\.?\s*$/m)
  return match?.[1]
}

/**
 * Mounts the partition, or reuses its current mount point when it is
 * already mounted (and remembers that, so {@link release} leaves it be).
 */
export async function ensureMounted(
  deps: OfflineDeps,
  out: Reporter,
  partition: BlockDevice,
): Promise<Mounted> {
  const current = partition.mountpoints[0]
  if (current) {
    out.line(
      `Using /dev/${partition.name}, already mounted at ${current} (left mounted at the end)`,
    )
    return { path: current, mountedByUs: false }
  }
  const result = await deps.runner.run(["udisksctl", "mount", "-b", `/dev/${partition.name}`])
  const path = result.success ? parseMountOutput(result.output) : undefined
  if (!path) {
    throw new UserError(
      `could not mount /dev/${partition.name}: ${
        (result.error || result.output).trim() || "no mount point reported"
      }`,
    )
  }
  out.line(`Mounted /dev/${partition.name} at ${path}`)
  return { path, mountedByUs: true }
}

export type ReleaseResult = "ejected" | "unmounted" | "left-mounted" | "unmount-failed"

/**
 * Undoes {@link ensureMounted}: a partition mounted before the command
 * stays mounted. Otherwise it is unmounted, and the disk powered off
 * unless `eject` is false (`--no-eject`).
 */
export async function release(
  deps: OfflineDeps,
  out: Reporter,
  disk: BlockDevice,
  partition: BlockDevice,
  mounted: Mounted,
  eject: boolean,
): Promise<ReleaseResult> {
  if (!mounted.mountedByUs) {
    out.line(`Left /dev/${partition.name} mounted at ${mounted.path}, as it was before.`)
    return "left-mounted"
  }
  const unmount = await deps.runner.run(["udisksctl", "unmount", "-b", `/dev/${partition.name}`])
  if (!unmount.success) {
    out.warn(
      `Could not unmount /dev/${partition.name}: ${unmount.error.trim()}. ` +
        `Unmount it before unplugging: udisksctl unmount -b /dev/${partition.name}`,
    )
    return "unmount-failed"
  }
  if (!eject) {
    out.line(`Unmounted /dev/${partition.name}; the drive stays powered (--no-eject).`)
    return "unmounted"
  }
  const off = await deps.runner.run(["udisksctl", "power-off", "-b", `/dev/${disk.name}`])
  if (!off.success) {
    out.warn(`Unmounted, but could not power off /dev/${disk.name}: ${off.error.trim()}`)
    return "unmounted"
  }
  out.line(`Ejected /dev/${disk.name}: safe to unplug.`)
  return "ejected"
}

/** The summary's wording for a {@link ReleaseResult}. */
export function describeRelease(result: ReleaseResult): string {
  switch (result) {
    case "ejected":
      return "ejected, safe to unplug"
    case "unmounted":
      return "unmounted, still powered"
    case "left-mounted":
      return "left mounted, as it was before"
    case "unmount-failed":
      return "still mounted: unmount failed"
  }
}
