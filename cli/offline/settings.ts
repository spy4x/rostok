// `rostok offline` settings: BACKUP_PATHS and BACKUPS_PASSWORD from the
// project's `.env.root`, read the way docker compose reads it.

import { join } from "@std/path"
import { decodeEnvValue, readEnvFile } from "../env-files.ts"
import { UserError } from "../errors.ts"
import type { BackupPath } from "./types.ts"

export interface OfflineSettings {
  backupPaths: BackupPath[]
  /** The restic password of every repository under the backup paths. */
  password: string
}

export const EXAMPLE_BACKUP_PATHS = `BACKUP_PATHS=[{"source":"~/backups","target":"restic-repos"}]`

/** A drive folder name: one path segment, never `logs`, `.` or `..`. */
const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Parses the `BACKUP_PATHS` JSON. Each `target` must be one plain folder
 * name: it is joined onto the drive's mount point and `rsync --delete`
 * runs into it, so `../x` would delete outside the drive.
 */
export function parseBackupPaths(json: string, file: string): BackupPath[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new UserError(
      `BACKUP_PATHS in ${file} is not valid JSON. Example: ${EXAMPLE_BACKUP_PATHS}`,
    )
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new UserError(
      `BACKUP_PATHS in ${file} must be a non-empty JSON array. Example: ${EXAMPLE_BACKUP_PATHS}`,
    )
  }
  const seen = new Set<string>()
  return parsed.map((entry) => {
    const source = entry?.source
    const target = entry?.target
    if (typeof source !== "string" || !source || typeof target !== "string" || !target) {
      throw new UserError(
        `every BACKUP_PATHS entry in ${file} needs "source" and "target". Example: ${EXAMPLE_BACKUP_PATHS}`,
      )
    }
    if (!TARGET_PATTERN.test(target) || target === "logs") {
      throw new UserError(
        `BACKUP_PATHS target "${target}" in ${file} must be one folder name (letters, digits, ` +
          `".", "_", "-"), and not "logs"`,
      )
    }
    if (seen.has(target)) {
      throw new UserError(`BACKUP_PATHS in ${file} uses the target "${target}" twice`)
    }
    seen.add(target)
    return { source, target }
  })
}

/**
 * Reads the settings from `<cwd>/.env.root`.
 *
 * @throws UserError when the file is missing (saying to run
 *   `rostok env decrypt` when only `.env.root.age` exists), or when a key
 *   is missing or malformed. The message names the key and the file.
 */
export async function loadSettings(cwd: string): Promise<OfflineSettings> {
  const file = join(cwd, ".env.root")
  if (!(await exists(file))) {
    if (await exists(`${file}.age`)) {
      throw new UserError(
        `${file} not found, but .env.root.age is there: run \`rostok env decrypt\` first`,
      )
    }
    throw new UserError(
      `${file} not found: run \`rostok offline\` from your rostok project's root folder`,
    )
  }
  const env = new Map((await readEnvFile(file)).map((e) => [e.key, decodeEnvValue(e.value)]))
  const missing = ["BACKUP_PATHS", "BACKUPS_PASSWORD"].filter((key) => !env.get(key))
  if (missing.length > 0) {
    const hint = missing.includes("BACKUP_PATHS")
      ? ` Example: ${EXAMPLE_BACKUP_PATHS}`
      : " Set it to the restic password of your backup repositories."
    throw new UserError(`${missing.join(" and ")} not set in ${file}.${hint}`)
  }
  return {
    backupPaths: parseBackupPaths(env.get("BACKUP_PATHS")!, file),
    password: env.get("BACKUPS_PASSWORD")!,
  }
}

/** `~` or `~/x` → the home folder. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home
  return path.startsWith("~/") ? join(home, path.slice(2)) : path
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false
    throw error
  }
}
