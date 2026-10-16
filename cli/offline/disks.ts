// Finding and choosing the drive: `lsblk` output, `--drive` checks and
// the disk picker.

import { UserError } from "../errors.ts"
import type { OfflineDeps } from "./context.ts"
import { PARTITION_LABEL } from "./types.ts"

/** A block device as `lsblk -J` describes it, children included. */
export interface BlockDevice {
  name: string
  type: string
  size: string
  model: string
  label: string
  mountpoints: string[]
  children: BlockDevice[]
}

/** Mount points that mark a disk as the running system's. */
export const SYSTEM_MOUNTS = ["/", "/boot", "/boot/efi", "/home", "[SWAP]"]

export const LSBLK_COMMAND = ["lsblk", "-J", "-o", "NAME,TYPE,SIZE,MODEL,LABEL,MOUNTPOINTS"]

interface RawDevice {
  name?: string
  type?: string
  size?: string | number
  model?: string | null
  label?: string | null
  mountpoints?: (string | null)[]
  mountpoint?: string | null
  children?: RawDevice[]
}

/** Parses `lsblk -J -o NAME,TYPE,SIZE,MODEL,LABEL,MOUNTPOINTS` output. */
export function parseLsblk(json: string): BlockDevice[] {
  const data = JSON.parse(json) as { blockdevices?: RawDevice[] }
  const convert = (raw: RawDevice): BlockDevice => ({
    name: raw.name ?? "",
    type: raw.type ?? "",
    size: String(raw.size ?? ""),
    model: (raw.model ?? "").trim(),
    label: raw.label ?? "",
    mountpoints: [...(raw.mountpoints ?? []), raw.mountpoint ?? null].filter(
      (m): m is string => typeof m === "string" && m !== "",
    ),
    children: (raw.children ?? []).map(convert),
  })
  return (data.blockdevices ?? []).map(convert)
}

/** Every block device on the machine, from `lsblk`. */
export async function listBlockDevices(deps: OfflineDeps): Promise<BlockDevice[]> {
  const result = await deps.runner.run(LSBLK_COMMAND)
  if (!result.success) {
    throw new UserError(`lsblk failed: ${result.error.trim() || "no output"}`)
  }
  try {
    return parseLsblk(result.output)
  } catch {
    throw new UserError("could not read the output of lsblk")
  }
}

/** Whole disks only. */
export function disksOf(devices: BlockDevice[]): BlockDevice[] {
  return devices.filter((d) => d.type === "disk")
}

/** `/dev/sda` → `sda`. Throws on anything that is not a plain device name. */
export function normalizeDriveName(input: string, flag = "--drive"): string {
  const name = input.trim().replace(/^\/dev\//, "")
  if (!/^[A-Za-z0-9]+$/.test(name)) {
    throw new UserError(`${flag} takes a disk name such as sda or /dev/sda, got "${input}"`)
  }
  return name
}

/** All mount points of a device and everything under it (partitions, LVM, LUKS). */
export function allMountpoints(device: BlockDevice): string[] {
  return [...device.mountpoints, ...device.children.flatMap(allMountpoints)]
}

/** The system paths mounted from this disk, empty for a disk that is safe to use. */
export function systemMountsOf(disk: BlockDevice): string[] {
  return allMountpoints(disk).filter((m) => SYSTEM_MOUNTS.includes(m))
}

/** The disk's partition labelled `OfflineBackups`, if it has one. */
export function backupPartitionOf(disk: BlockDevice): BlockDevice | undefined {
  return disk.children.find((c) => c.type === "part" && c.label === PARTITION_LABEL)
}

/** One line per disk: name, size, model, label of the first partition. */
export function describeDisk(disk: BlockDevice): string {
  const first = disk.children.find((c) => c.type === "part")
  const label = first?.label ? first.label : "no label"
  const marks: string[] = []
  if (label === PARTITION_LABEL) marks.push("offline backup drive")
  if (systemMountsOf(disk).length > 0) marks.push("system disk")
  const mark = marks.length > 0 ? `  (${marks.join(", ")})` : ""
  return `${disk.name.padEnd(8)} ${disk.size.padStart(6)}  ${
    disk.model || "unknown model"
  }  [${label}]${mark}`
}

/** The disk list used by the picker, the missing-`--drive` error and `status`. */
export function formatDiskList(disks: BlockDevice[]): string {
  if (disks.length === 0) return "  (no disks found)"
  return disks.map((d) => `  ${describeDisk(d)}`).join("\n")
}

/** Finds `name` among the devices and checks it is a whole disk that holds no system path. */
export function validateDisk(devices: BlockDevice[], name: string): BlockDevice {
  const disks = disksOf(devices)
  const disk = disks.find((d) => d.name === name)
  if (!disk) {
    const isPartition = devices.some((d) =>
      d.children.some(function walk(c): boolean {
        return c.name === name || c.children.some(walk)
      })
    )
    if (isPartition) {
      throw new UserError(
        `${name} is a partition, not a whole disk: pass the disk it belongs to. Disks found:\n` +
          formatDiskList(disks),
      )
    }
    throw new UserError(`no disk named ${name}. Disks found:\n${formatDiskList(disks)}`)
  }
  const system = systemMountsOf(disk)
  if (system.length > 0) {
    throw new UserError(
      `${name} holds the running system (${system.join(", ")} mounted from it): refusing to use it`,
    )
  }
  return disk
}

/**
 * The disk to work on: `--drive` when given; at a terminal, a picker
 * whose first, highlighted entry is "cancel", so Enter alone picks no
 * disk; otherwise an error that lists the disks, so a script or an agent
 * can pick one without running another command.
 */
export async function resolveDisk(
  deps: OfflineDeps,
  drive: string | undefined,
  interactive: boolean,
): Promise<BlockDevice> {
  const devices = await listBlockDevices(deps)
  const disks = disksOf(devices)
  if (drive !== undefined) return validateDisk(devices, normalizeDriveName(drive))
  if (!interactive) {
    throw new UserError(
      `no drive given: pass --drive <disk>, for example --drive sda. Disks found:\n` +
        formatDiskList(disks),
    )
  }
  if (disks.length === 0) throw new UserError("no disks found")
  const picked = await deps.selectFn({
    message: "Which disk?",
    options: [
      { name: "cancel", value: "" },
      ...disks.map((d) => ({
        name: describeDisk(d),
        value: d.name,
        disabled: systemMountsOf(d).length > 0,
      })),
    ],
  })
  if (!picked) throw new UserError("no disk chosen")
  return validateDisk(devices, picked)
}
