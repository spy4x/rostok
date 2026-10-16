// `rostok offline format`: erase a disk and give it one btrfs partition
// labelled OfflineBackups. The only command that formats.

import { UserError } from "../errors.ts"
import { assertLinux, type DriveOptions, isInteractive, requireTools } from "./common.ts"
import { type OfflineDeps, Reporter } from "./context.ts"
import {
  allMountpoints,
  type BlockDevice,
  describeDisk,
  disksOf,
  listBlockDevices,
  normalizeDriveName,
  resolveDisk,
} from "./disks.ts"
import { ensureSudo } from "./sudo.ts"
import { PARTITION_LABEL } from "./types.ts"

export interface FormatOptions extends DriveOptions {
  /** Must repeat the disk name; required without a terminal. */
  confirm?: string
}

/**
 * Throws unless erasing `disk` is confirmed: `--confirm` equal to the
 * disk name, or the name typed at a terminal. `-n` alone never confirms.
 */
async function confirmErase(
  deps: OfflineDeps,
  disk: BlockDevice,
  confirm: string | undefined,
  interactive: boolean,
): Promise<void> {
  if (confirm !== undefined) {
    const given = normalizeDriveName(confirm, "--confirm")
    if (given !== disk.name) {
      throw new UserError(
        `--confirm ${given} does not match the disk ${disk.name}: nothing was erased`,
      )
    }
    return
  }
  if (!interactive) {
    throw new UserError(
      `format erases everything on /dev/${disk.name}: pass --confirm ${disk.name} to confirm`,
    )
  }
  const typed = await deps.promptFn(
    { message: `Type the disk name (${disk.name}) to erase it` },
    false,
  )
  if (typed.trim().replace(/^\/dev\//, "") !== disk.name) {
    throw new UserError("format cancelled; nothing was erased")
  }
}

/** Runs one sudo command and throws a UserError naming `what` when it fails. */
async function sudoStep(deps: OfflineDeps, cmd: string[], what: string): Promise<void> {
  const result = await deps.runner.run(cmd, { sudo: true })
  if (!result.success) throw new UserError(`${what} failed: ${result.error.trim()}`)
}

/**
 * Runs `rostok offline format`. Refuses a system disk (resolveDisk) and
 * a disk with anything mounted, and fails fast when sudo would need a
 * password nobody can type.
 */
export async function runFormat(deps: OfflineDeps, opts: FormatOptions): Promise<void> {
  assertLinux(deps)
  const interactive = isInteractive(deps, opts.nonInteractive)
  const out = new Reporter(deps)
  const disk = await resolveDisk(deps, opts.drive, interactive)
  const mounted = allMountpoints(disk)
  if (mounted.length > 0) {
    throw new UserError(
      `${disk.name} has mounted partitions (${mounted.join(", ")}): unmount them first, ` +
        `for example: udisksctl unmount -b /dev/${disk.children[0]?.name ?? disk.name}`,
    )
  }
  out.line(`This erases everything on /dev/${disk.name}:`)
  out.line(`  ${describeDisk(disk)}`)
  await confirmErase(deps, disk, opts.confirm, interactive)
  await requireTools(deps, ["parted", "mkfs.btrfs"])
  if (!(await ensureSudo(deps, out, interactive, "formatting"))) {
    throw new UserError(
      "format needs sudo, and sudo needs a password: run it at a terminal, " +
        "or allow passwordless sudo",
    )
  }

  const device = `/dev/${disk.name}`
  await out.step("Create the partition table", async () => {
    await sudoStep(deps, ["parted", device, "--script", "mklabel", "gpt"], "parted mklabel")
    await sudoStep(
      deps,
      ["parted", device, "--script", "mkpart", "primary", "btrfs", "0%", "100%"],
      "parted mkpart",
    )
  })
  const partition = await findNewPartition(deps, disk.name)
  await out.step(`Format /dev/${partition} as btrfs, label ${PARTITION_LABEL}`, () =>
    sudoStep(
      deps,
      ["mkfs.btrfs", "-f", "-L", PARTITION_LABEL, `/dev/${partition}`],
      "mkfs.btrfs",
    ))
  out.line(`Done. Next: rostok offline backup --drive ${disk.name}`)
}

/** Waits up to ten seconds for the kernel to show the new partition. */
async function findNewPartition(deps: OfflineDeps, diskName: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const disk = disksOf(await listBlockDevices(deps)).find((d) => d.name === diskName)
    const partition = disk?.children.find((c) => c.type === "part")
    if (partition) return partition.name
    await deps.sleep(1000)
  }
  throw new UserError(`the new partition on /dev/${diskName} did not appear; check with lsblk`)
}
