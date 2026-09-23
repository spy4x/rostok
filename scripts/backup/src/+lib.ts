import { getEnvVar } from "../../+lib.ts"

// Re-export getEnvVar for consumers that import from this module
export { getEnvVar } from "../../+lib.ts"

export const USER = getEnvVar("SSH_USER")
export const PATH_APPS = getEnvVar("PATH_APPS")
export const VOLUMES_PATH = getEnvVar("VOLUMES_PATH")
export const PATH_MEDIA = getEnvVar("PATH_MEDIA", true) // Optional - only on home server
export const PATH_SYNC = getEnvVar("PATH_SYNC")
export const SERVER_NAME = getEnvVar("SERVER_NAME")

export interface BackupConfig {
  name: string
  destName?: string // Optional: override destination folder/repo name (e.g., "gatus-home" for shared services)
  sourcePaths: "default" | string[]
  pathsToChangeOwnership?: "default" | string[]
  containers?: {
    stop: "default" | string[]
  }
}
