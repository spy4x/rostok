// `rostok offline status`: what a backup would use — settings, disks,
// tools — without mounting anything or needing root.

import { UserError } from "../errors.ts"
import { assertLinux } from "./common.ts"
import { type OfflineDeps, Reporter } from "./context.ts"
import { disksOf, formatDiskList, listBlockDevices } from "./disks.ts"
import { expandHome, loadSettings } from "./settings.ts"
import { hasPasswordlessSudo } from "./sudo.ts"
import { getSize } from "./verify.ts"

/** Tools `status` reports, and what each is for. `required` ones fail the status. */
export const TOOLS: { name: string; purpose: string; required: boolean }[] = [
  { name: "lsblk", purpose: "lists the disks", required: true },
  { name: "rsync", purpose: "copies the repositories", required: true },
  { name: "restic", purpose: "checks the repositories", required: true },
  { name: "udisksctl", purpose: "mounts and ejects without root", required: true },
  { name: "smartctl", purpose: "SMART health test (optional)", required: false },
  { name: "parted", purpose: "format only", required: false },
  { name: "mkfs.btrfs", purpose: "format only", required: false },
]

/**
 * Runs `rostok offline status`: prints everything, then throws a
 * UserError (exit 1) naming each required setting or tool that is missing.
 */
export async function runStatus(deps: OfflineDeps): Promise<void> {
  assertLinux(deps)
  const out = new Reporter(deps)
  const problems: string[] = []

  out.line("Backup paths (BACKUP_PATHS in .env.root):")
  try {
    const settings = await loadSettings(deps.cwd)
    for (const bp of settings.backupPaths) {
      const local = expandHome(bp.source, deps.home)
      let size: string
      try {
        size = (await Deno.stat(local)).isDirectory
          ? (await getSize(deps, local)).human
          : "not a folder"
      } catch {
        size = "missing"
      }
      if (size === "missing" || size === "not a folder") problems.push(`${local} is ${size}`)
      out.line(`  ${bp.source} → ${bp.target}  (${size})`)
    }
    out.line("  BACKUPS_PASSWORD: set")
  } catch (error) {
    if (!(error instanceof UserError)) throw error
    out.line(`  ✗ ${error.message}`)
    problems.push("settings")
  }

  out.line("")
  out.line("Disks:")
  try {
    out.line(formatDiskList(disksOf(await listBlockDevices(deps))))
  } catch (error) {
    if (!(error instanceof UserError)) throw error
    out.line(`  ✗ ${error.message}`)
  }

  out.line("")
  out.line("Tools:")
  for (const tool of TOOLS) {
    const found = await deps.hasCommand(tool.name)
    if (!found && tool.required) problems.push(tool.name)
    out.line(`  ${found ? "✓" : "✗"} ${tool.name.padEnd(11)} ${tool.purpose}`)
  }
  const sudo = await hasPasswordlessSudo(deps)
  out.line(
    `  ${sudo ? "✓" : "✗"} ${"sudo -n".padEnd(11)} ${
      sudo
        ? "works without a password"
        : "needs a password: SMART test and ownership fix ask for it at a terminal, skip or stop without one"
    }`,
  )

  out.line("")
  if (problems.length > 0) {
    throw new UserError(`not ready: missing ${problems.join(", ")}`)
  }
  out.line("Ready: rostok offline backup --drive <disk>")
}
