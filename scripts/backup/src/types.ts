import { BackupConfig } from "./+lib.ts"

export enum BackupStatus {
  IN_PROGRESS = 1,
  SUCCESS = 2,
  ERROR = 3,
}

export type BackupConfigState = BackupConfig & {
  discoveryName?: string
  fileName: string
  status: BackupStatus
  error?: string
  errorAtStep?: string
  sizeGB?: number
  sizeError?: string
  durationMs?: number
}

export interface BackupContext {
  serverName: string
  backupsOutputBasePath: string
  backupsPassword: string
  ntfyUrl: string
  ntfyAuth: string
  stacksPath: string
  configsPath: string
  healthchecksUrl?: string // Optional healthchecks.io-style ping URL
}

export interface BackupResult {
  backups: BackupConfigState[]
  successCount: number
  totalCount: number
  totalSizeGB: number
  durationMs: number
}

export interface ResticCommandOptions {
  args: string[]
  config: BackupConfigState
  step: string
  workingDir?: string
}
