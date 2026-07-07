import { runCommand } from "../../+lib.ts"
import type { BackupPath, DriveInfo } from "./types.ts"
import { LOGS_DIR } from "./types.ts"

export async function listDrives(): Promise<DriveInfo[]> {
  const result = await runCommand(["lsblk", "-ndo", "NAME,SIZE,MODEL,TYPE"])
  const text = result.output

  return text
    .trim()
    .split("\n")
    .map((line) => {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 4) return null
      return {
        name: parts[0],
        size: parts[1],
        model: parts.slice(2, -1).join(" "),
        type: parts[parts.length - 1],
      }
    })
    .filter((d): d is DriveInfo => d !== null && d.type === "disk")
}

export async function checkDriveExists(driveName: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(`/dev/${driveName}`)
    return stat.isBlockDevice ?? false
  } catch {
    return false
  }
}

export async function isMounted(device: string): Promise<boolean> {
  const result = await runCommand(["mount"])
  return result.output.includes(device)
}

export async function getMountPoint(device: string): Promise<string | null> {
  const result = await runCommand(["mount"])
  const lines = result.output.split("\n")
  for (const line of lines) {
    if (line.includes(device)) {
      const parts = line.split(" ")
      const onIndex = parts.indexOf("on")
      if (onIndex > -1 && parts[onIndex + 1]) {
        return parts[onIndex + 1]
      }
    }
  }
  return null
}

export async function mountDrive(device: string): Promise<string> {
  console.log(`🔗 Mounting ${device}...`)
  const result = await runCommand(["udisksctl", "mount", "-b", device])

  if (!result.success) {
    throw new Error(`Failed to mount: ${result.error}`)
  }

  const mountMatch = result.output.match(/at\s+(.+?)[\s\n]/) || result.output.match(/at\s+(.+)$/)
  if (mountMatch && mountMatch[1]) {
    const mountPoint = mountMatch[1].trim().replace(/\.$/, "")
    console.log(`✅ Drive mounted at: ${mountPoint}`)
    return mountPoint
  }

  throw new Error("Could not determine mount point from udisksctl output")
}

export async function unmountDrive(device: string, mountPoint: string): Promise<void> {
  console.log(`📤 Unmounting ${device}...`)
  const result = await runCommand(["udisksctl", "unmount", "-b", device])

  if (!result.success) {
    console.warn(`⚠️  Warning: Failed to unmount: ${result.error}`)
  } else {
    console.log("✅ Drive unmounted successfully")
  }

  try {
    const homeDir = Deno.env.get("HOME") || "~"
    if (mountPoint.startsWith(homeDir)) {
      await Deno.remove(mountPoint)
      console.log(`🗑️  Removed mount point: ${mountPoint}`)
    }
  } catch {
    // Ignore errors
  }
}

export async function ejectDrive(device: string): Promise<void> {
  console.log(`⏏️  Ejecting ${device}...`)
  const result = await runCommand(["udisksctl", "power-off", "-b", device])

  if (!result.success) {
    console.warn(`⚠️  Warning: Could not eject drive: ${result.error}`)
  } else {
    console.log(
      "✅ Drive ejected successfully - safe to unplug. To mount again, re-plug the drive.",
    )
  }
}

export async function formatDrive(device: string): Promise<void> {
  console.log(`⚠️  WARNING: This will ERASE ALL DATA on ${device}!`)
  console.log("Device info:")

  const drives = await listDrives()
  const drive = drives.find((d) => d.name === device.replace("/dev/", ""))
  if (drive) {
    console.log(`  Name: ${drive.name}`)
    console.log(`  Size: ${drive.size}`)
    console.log(`  Model: ${drive.model}`)
  }

  const confirmation = prompt("\nType 'YES' to continue: ")
  if (confirmation !== "YES") {
    console.log("❌ Formatting cancelled")
    Deno.exit(0)
  }

  console.log("\n🔧 Creating GPT partition table...")
  let result = await runCommand(
    ["parted", device, "--script", "mklabel", "gpt"],
    { sudo: true },
  )
  if (!result.success) {
    throw new Error(`Failed to create partition table: ${result.error}`)
  }

  console.log("🔧 Creating primary partition...")
  result = await runCommand(
    ["parted", device, "--script", "mkpart", "primary", "btrfs", "0%", "100%"],
    { sudo: true },
  )
  if (!result.success) {
    throw new Error(`Failed to create partition: ${result.error}`)
  }

  await new Promise((resolve) => setTimeout(resolve, 2000))

  const partition = `${device}1`
  console.log(`💾 Formatting ${partition} with BTRFS...`)
  result = await runCommand(
    ["mkfs.btrfs", "-f", "-L", "OfflineBackups", partition],
    { sudo: true },
  )
  if (!result.success) {
    throw new Error(`Failed to format: ${result.error}`)
  }

  console.log("✅ Drive formatted successfully")
}

export async function createBackupStructure(
  mountPoint: string,
  backupPaths: BackupPath[],
): Promise<void> {
  console.log("📁 Ensuring backup directory structure...")

  const username = Deno.env.get("USER") || "user"
  const chownResult = await runCommand(["chown", "-R", username, mountPoint], { sudo: true })
  if (!chownResult.success) {
    console.warn(`⚠️  Could not change ownership: ${chownResult.error}`)
  }

  const dirs = [
    `${mountPoint}/${LOGS_DIR}`,
    ...backupPaths.map((bp) => `${mountPoint}/${bp.target}`),
  ]

  for (const dir of dirs) {
    await Deno.mkdir(dir, { recursive: true })
  }

  console.log("✅ Directory structure created")
}
