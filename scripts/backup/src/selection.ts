import type { BackupConfigState } from "./types.ts"

export function selectBackupConfigurations(
  backups: BackupConfigState[],
  requestedNames: string[],
): BackupConfigState[] {
  if (requestedNames.length === 0) return backups

  const requested = new Set(requestedNames)
  const available = new Set(backups.map((backup) => backup.discoveryName || backup.name))
  const unknown = [...requested].filter((name) => !available.has(name))

  if (unknown.length > 0) {
    throw new Error(`Unknown backup configuration: ${unknown.join(", ")}`)
  }

  return backups.filter((backup) => requested.has(backup.discoveryName || backup.name))
}
