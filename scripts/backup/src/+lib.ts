import { readEnvVar, systemEnv } from "@spy4x/server/config/env"

export const USER = readEnvVar(systemEnv, "SSH_USER")
export const PATH_APPS = readEnvVar(systemEnv, "PATH_APPS")
export const VOLUMES_PATH = readEnvVar(systemEnv, "VOLUMES_PATH")
export const PATH_MEDIA = readEnvVar(systemEnv, "PATH_MEDIA", { optional: true }) // Optional - only on home server
export const PATH_SYNC = readEnvVar(systemEnv, "PATH_SYNC")
export const SERVER_NAME = readEnvVar(systemEnv, "SERVER_NAME")

export interface BackupConfig {
  name: string
  destName?: string // Optional: override destination folder/repo name (e.g., "gatus-home" for shared services)
  sourcePaths: "default" | string[]
  pathsToChangeOwnership?: "default" | string[]
  containers?: {
    stop: "default" | string[]
  }
}
