export interface BackupPath {
  source: string
  target: string
}

export interface DriveInfo {
  name: string
  size: string
  model: string
  type: string
}

export interface VerificationDetail {
  name: string
  status: "passed" | "failed" | "skipped"
  error?: string
}

export interface VerifyResults {
  passed: number
  failed: number
  skipped: number
  details: VerificationDetail[]
}

export const LOGS_DIR = "logs"
