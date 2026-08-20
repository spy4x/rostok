import { getBackupSize } from "./verify.ts"
import type { BackupPath } from "./types.ts"
import { LOGS_DIR } from "./types.ts"

export class ConsoleLogger {
  private logs: string[] = []
  private originalLog: typeof console.log
  private originalError: typeof console.error
  private originalWarn: typeof console.warn

  constructor() {
    this.originalLog = console.log.bind(console)
    this.originalError = console.error.bind(console)
    this.originalWarn = console.warn.bind(console)
  }

  start() {
    console.log = (...args: unknown[]) => {
      const message = args.map((a) => String(a)).join(" ")
      this.logs.push(`[${new Date().toISOString()}] ${message}`)
      this.originalLog(...args)
    }
    console.error = (...args: unknown[]) => {
      const message = args.map((a) => String(a)).join(" ")
      this.logs.push(`[${new Date().toISOString()}] ERROR: ${message}`)
      this.originalError(...args)
    }
    console.warn = (...args: unknown[]) => {
      const message = args.map((a) => String(a)).join(" ")
      this.logs.push(`[${new Date().toISOString()}] WARN: ${message}`)
      this.originalWarn(...args)
    }
  }

  stop() {
    console.log = this.originalLog
    console.error = this.originalError
    console.warn = this.originalWarn
  }

  getLogs(): string[] {
    return [...this.logs]
  }
}

export async function saveBackupLog(
  mountPoint: string,
  logContent: string,
  success: boolean,
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  const status = success ? "success" : "failed"
  const logDir = `${mountPoint}/${LOGS_DIR}`
  const logFile = `${logDir}/${timestamp}_${status}.log`

  try {
    await Deno.mkdir(logDir, { recursive: true })
    await Deno.writeTextFile(logFile, logContent)
    console.log(`\n📝 Log saved: ${logFile}`)
  } catch (error) {
    console.error("Warning: Could not save backup log:", error)
  }
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let size = bytes
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`
}

export async function writeReadme(
  mountPoint: string,
  backupPaths: BackupPath[],
): Promise<void> {
  console.log("📝 Writing README...")

  const now = new Date()
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate())

  let totalBytes = 0
  const pathSizes: Array<{ path: BackupPath; size: string }> = []

  for (const backupPath of backupPaths) {
    const targetDir = `${mountPoint}/${backupPath.target}`
    const backupSize = await getBackupSize(targetDir)
    totalBytes += backupSize.bytes
    pathSizes.push({ path: backupPath, size: backupSize.human })
  }

  const totalHuman = formatBytes(totalBytes)

  const pathsInfo = pathSizes.map((ps) => `  - ${ps.path.source} → ${ps.path.target} (${ps.size})`)
    .join("\n")

  const readmeContent = `# Homelab Offline Backup Drive

This drive contains encrypted backups of critical homelab services.

## Quick Start

**Restore Command:**  
\`\`\`bash
cd ~/dev/rostok && deno task offline-backup restore
\`\`\`

**Password Location:** \`~/dev/rostok/.env\` file as \`BACKUPS_PASSWORD\`

## Storage (Singapore Climate)

Store in dry cabinet ($50-200 SGD) or sealed container with desiccant.  
Keep at 20-25°C, <60% humidity, elevated from floor.

---

## Backup Information

**Created:** ${now.toISOString().split("T")[0]} ${
    now.toTimeString().split(" ")[0]
  } ${Intl.DateTimeFormat().resolvedOptions().timeZone}
**Backup Paths:**
${pathsInfo}
**Type:** Restic repositories
**Encryption:** Yes (Restic native encryption)
**Schedule:** Monthly offline backup
**Next Update Due:** ${nextMonth.toISOString().split("T")[0]}
**Total Backup Size:** ${totalHuman} (${totalBytes.toLocaleString()} bytes)

### Important Notes

- Keep drive in protective case
- Store in climate-controlled area (20-25°C, <60% humidity)
- Keep away from magnets and water
- Update monthly
- Verify backup integrity after sync

### Password Location

Restic password is stored in the "spy4x/rostok" code repository on GitHub in: \`.env\` file as \`BACKUPS_PASSWORD\`.
Actual .env file is not committed to the repository for security.
But you can find its content in VaultWarden (password manager) entry named \`Homelab .env\`.
Also it should be located on the local computer in \`~/dev/rostok/.env\` and on the home server in \`~/<apps_folder>/.env\`.

### Quick Restore

Connect drive and execute \`deno task offline-backup restore\` from homelab repo.  
The script will guide you through the restore process.
`

  const readmePath = `${mountPoint}/README.md`
  await Deno.writeTextFile(readmePath, readmeContent)

  console.log("✅ README written")
}

export function parseBackupPaths(backupPathsJson: string): BackupPath[] {
  let backupPaths: BackupPath[]
  try {
    backupPaths = JSON.parse(backupPathsJson)
    if (!Array.isArray(backupPaths) || backupPaths.length === 0) {
      throw new Error("BACKUP_PATHS must be a non-empty array")
    }
    for (const bp of backupPaths) {
      if (!bp.source || !bp.target) {
        throw new Error("Each backup path must have 'source' and 'target' properties")
      }
    }
  } catch (error) {
    throw new Error(`Invalid BACKUP_PATHS format: ${error}`)
  }
  return backupPaths
}

export async function validateBackupSources(backupPaths: BackupPath[]): Promise<void> {
  for (const backupPath of backupPaths) {
    const expanded = backupPath.source.replace(/^~/, Deno.env.get("HOME") || "~")
    try {
      const stat = await Deno.stat(expanded)
      if (!stat.isDirectory) {
        console.error(`❌ Error: ${expanded} is not a directory`)
        Deno.exit(1)
      }
    } catch {
      console.error(`❌ Error: ${expanded} does not exist`)
      Deno.exit(1)
    }
  }
}
