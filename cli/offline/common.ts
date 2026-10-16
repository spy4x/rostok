// Steps every `rostok offline` subcommand shares.

import { join } from "@std/path"
import { UserError } from "../errors.ts"
import type { OfflineDeps, Reporter } from "./context.ts"
import { backupPartitionOf, type BlockDevice, resolveDisk } from "./disks.ts"
import { expandHome } from "./settings.ts"
import type { BackupPath } from "./types.ts"

/** Flags every subcommand but `status` takes. */
export interface DriveOptions {
  drive?: string
  nonInteractive?: boolean
}

/** Questions are asked only at a terminal and without `-n`. */
export function isInteractive(deps: OfflineDeps, nonInteractive: boolean | undefined): boolean {
  return !nonInteractive && deps.isTerminal()
}

/** `rostok offline` drives Linux tools (lsblk, udisksctl, smartctl). */
export function assertLinux(deps: OfflineDeps): void {
  if (deps.os !== "linux") {
    throw new UserError(
      `rostok offline works on Linux only (it uses lsblk, udisksctl and smartctl); this is ${deps.os}`,
    )
  }
}

/** Throws a UserError naming every tool in `tools` that is not installed. */
export async function requireTools(deps: OfflineDeps, tools: string[]): Promise<void> {
  const missing: string[] = []
  for (const tool of tools) {
    if (!(await deps.hasCommand(tool))) missing.push(tool)
  }
  if (missing.length > 0) {
    throw new UserError(
      `not installed: ${missing.join(", ")}. Install ${
        missing.length === 1 ? "it" : "them"
      } and run again; \`rostok offline status\` shows what is missing.`,
    )
  }
}

/** The chosen disk and its `OfflineBackups` partition. */
export interface BackupDrive {
  disk: BlockDevice
  partition: BlockDevice
}

/**
 * Resolves the disk and finds its backup partition. A disk without one is
 * refused with the command that prepares it; nothing here formats.
 */
export async function openBackupDrive(
  deps: OfflineDeps,
  out: Reporter,
  drive: string | undefined,
  interactive: boolean,
): Promise<BackupDrive> {
  const disk = await resolveDisk(deps, drive, interactive)
  const partition = backupPartitionOf(disk)
  if (!partition) {
    throw new UserError(
      `${disk.name} has no partition labelled OfflineBackups. To prepare a new drive (this ` +
        `erases it), run: rostok offline format --drive ${disk.name}`,
    )
  }
  out.line(`Drive: /dev/${disk.name} (${disk.size}${disk.model ? `, ${disk.model}` : ""})`)
  return { disk, partition }
}

/** Throws a UserError when a local backup source is missing or is not a folder. */
export async function assertSourcesExist(backupPaths: BackupPath[], home: string): Promise<void> {
  for (const bp of backupPaths) {
    const path = expandHome(bp.source, home)
    let isDirectory = false
    try {
      isDirectory = (await Deno.stat(path)).isDirectory
    } catch {
      throw new UserError(`backup source ${path} (BACKUP_PATHS in .env.root) does not exist`)
    }
    if (!isDirectory) {
      throw new UserError(`backup source ${path} (BACKUP_PATHS in .env.root) is not a folder`)
    }
  }
}

/** The backup paths whose target folder is on the drive; warns about the others. */
export async function targetsOnDrive(
  out: Reporter,
  backupPaths: BackupPath[],
  mountPoint: string,
): Promise<BackupPath[]> {
  const found: BackupPath[] = []
  for (const bp of backupPaths) {
    try {
      if ((await Deno.stat(join(mountPoint, bp.target))).isDirectory) {
        found.push(bp)
        continue
      }
    } catch {
      // reported below
    }
    out.warn(`${bp.target}/ is not on the drive`)
  }
  if (found.length === 0) {
    throw new UserError(
      `none of the BACKUP_PATHS targets are on the drive at ${mountPoint}: ` +
        `is this the right drive? \`rostok offline backup\` creates them.`,
    )
  }
  return found
}
