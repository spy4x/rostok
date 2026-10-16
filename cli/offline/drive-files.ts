// Files `rostok offline backup` leaves on the drive: README.md, the
// folders it copies into, and one log per run under logs/.

import { join } from "@std/path"
import { formatBytes } from "@spy4x/platform/universal/format-number"
import { UserError } from "../errors.ts"
import type { OfflineDeps, Reporter } from "./context.ts"
import { ensureSudo } from "./sudo.ts"
import { getSize } from "./verify.ts"
import { type BackupPath, LOGS_DIR } from "./types.ts"

/** How a person installs the CLI that can restore the drive. */
export const INSTALL_COMMAND = "deno install -g -A -n rostok jsr:@rostok/cli"

/**
 * Makes the drive writable for the current user and creates the target
 * and log folders. A freshly formatted partition belongs to root, so its
 * ownership is fixed with `sudo -n chown` (after asking for the password
 * once at a terminal).
 */
export async function prepareDrive(
  deps: OfflineDeps,
  out: Reporter,
  mountPoint: string,
  backupPaths: BackupPath[],
  interactive: boolean,
): Promise<void> {
  const owner = (await Deno.stat(mountPoint)).uid
  if (deps.uid !== null && owner !== null && owner !== deps.uid) {
    if (!(await ensureSudo(deps, out, interactive, "making the drive writable"))) {
      throw new UserError(
        `${mountPoint} belongs to another user and sudo needs a password: run at a terminal, ` +
          `or once by hand: sudo chown -R ${deps.user} ${mountPoint}`,
      )
    }
    const chown = await deps.runner.run(["chown", "-R", deps.user, mountPoint], { sudo: true })
    if (!chown.success) {
      throw new UserError(`could not take ownership of ${mountPoint}: ${chown.error.trim()}`)
    }
  }
  for (const dir of [LOGS_DIR, ...backupPaths.map((bp) => bp.target)]) {
    await Deno.mkdir(join(mountPoint, dir), { recursive: true })
  }
}

/** `2026-10-16T09:05:01.123Z` → `2026-10-16T09-05-01`, safe in a file name. */
export function logStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, "-").slice(0, 19)
}

/** The log file a run started at `startedAt` writes, under the drive's logs/. */
export function logPath(mountPoint: string, startedAt: number, success: boolean): string {
  return join(mountPoint, LOGS_DIR, `${logStamp(startedAt)}_${success ? "success" : "failed"}.log`)
}

/**
 * Writes the run's log to the drive. When that fails, writes it to a
 * temporary file instead and returns that path, so the log is never lost.
 */
export async function saveLog(path: string, content: string): Promise<string> {
  try {
    await Deno.mkdir(join(path, ".."), { recursive: true })
    await Deno.writeTextFile(path, content)
    return path
  } catch {
    const local = await Deno.makeTempFile({ prefix: "rostok-offline-", suffix: ".log" })
    await Deno.writeTextFile(local, content)
    return local
  }
}

/** Writes README.md at the root of the drive: what it holds and how to restore it. */
export async function writeReadme(
  deps: OfflineDeps,
  mountPoint: string,
  backupPaths: BackupPath[],
): Promise<void> {
  const now = new Date(deps.now())
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())
  let totalBytes = 0
  const lines: string[] = []
  for (const bp of backupPaths) {
    const size = await getSize(deps, join(mountPoint, bp.target))
    totalBytes += size.bytes
    lines.push(`- \`${bp.target}/\` ← \`${bp.source}\` (${size.human})`)
  }

  const readme = `# Rostok offline backup drive

Encrypted restic repositories, copied here by \`rostok offline backup\`.

## Restore

1. Install rostok: \`${INSTALL_COMMAND}\` (needs [Deno](https://deno.land) 2).
2. In your rostok project folder (the one \`rostok init\` created), make sure
   \`.env.root\` holds \`BACKUP_PATHS\` and \`BACKUPS_PASSWORD\`
   (\`rostok env decrypt\` writes it from \`.env.root.age\`).
3. Plug in this drive and run:

   \`\`\`bash
   rostok offline restore --drive <disk>
   \`\`\`

   \`rostok offline status\` lists the disk names; this drive's partition
   is labelled \`OfflineBackups\`.

The restic password is \`BACKUPS_PASSWORD\`. Keep a copy in your password
manager: without it these backups cannot be read.

## Contents

Written ${now.toISOString().slice(0, 16).replace("T", " ")} UTC.
Next copy due ${nextMonth.toISOString().slice(0, 10)}.

${lines.join("\n")}

Total: ${formatBytes(totalBytes)} (${totalBytes} bytes). One log per run is in \`${LOGS_DIR}/\`.

## Storage

Keep the drive dry and cool (20-25°C, under 60% humidity), away from
magnets and water, and refresh it monthly.
`
  await Deno.writeTextFile(join(mountPoint, "README.md"), readme)
}
