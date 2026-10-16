// Shared shapes for `rostok offline`.

/** One entry of `BACKUP_PATHS`: a local folder and the folder name it gets on the drive. */
export interface BackupPath {
  /** Local folder, `~` allowed. */
  source: string
  /** Folder name at the root of the drive's backup partition. */
  target: string
}

/** One repository's result from `restic check`. */
export interface VerificationDetail {
  name: string
  status: "passed" | "failed" | "skipped"
  error?: string
}

/** The tally of a verification pass. */
export interface VerifyResults {
  passed: number
  failed: number
  skipped: number
  details: VerificationDetail[]
}

/** Folder on the drive that holds one log file per run. */
export const LOGS_DIR = "logs"

/** Filesystem label of the backup partition; `rostok offline format` sets it. */
export const PARTITION_LABEL = "OfflineBackups"

/** `--check` values of `backup`. `verify` takes the first two only. */
export const CHECK_MODES = ["fast", "full", "skip"] as const
export type CheckMode = typeof CHECK_MODES[number]

/** `--smart` values. */
export const SMART_MODES = ["short", "long", "skip"] as const
export type SmartMode = typeof SMART_MODES[number]
