import { absPath, error, getEnvVar } from "../../+lib.ts"
import { BackupConfigState, BackupStatus } from "./types.ts"

export class BackupConfigProcessor {
  /**
   * Validates and normalizes a backup configuration
   */
  static validateAndNormalize(config: BackupConfigState): boolean {
    if (!config.name) {
      config.name = config.fileName
      this.markConfigFailed(config, "Backup config is missing a name")
      return false
    }

    // Normalize source paths
    if (config.sourcePaths === "default") {
      config.sourcePaths = this.getDefaultSourcePaths(config)
    }

    if (!config.sourcePaths || config.sourcePaths.length === 0) {
      this.markConfigFailed(config, "Backup config is missing source paths")
      return false
    }

    // Validate source paths exist
    for (const path of config.sourcePaths) {
      if (!this.checkPathExists(config, path)) {
        return false
      }
    }

    // Normalize ownership paths
    if (config.pathsToChangeOwnership === "default") {
      config.pathsToChangeOwnership = this.getDefaultSourcePaths(config)
    }

    // Normalize containers
    if (config.containers?.stop === "default") {
      config.containers.stop = ["__compose__"]
    }

    return true
  }

  /**
   * Gets default source paths for a backup configuration
   */
  private static getDefaultSourcePaths(backup: BackupConfigState): string[] {
    return [`${getEnvVar("VOLUMES_PATH")}/${backup.name}`]
  }

  /**
   * Checks if a path exists and is accessible
   */
  private static checkPathExists(config: BackupConfigState, path: string): boolean {
    const absolutePath = absPath(path, getEnvVar("USER"))
    try {
      const stat = Deno.statSync(absolutePath)
      if (!stat) {
        this.markConfigFailed(config, `Source path ${absolutePath} does not exist`)
        return false
      }
      return true
    } catch {
      this.markConfigFailed(config, `Source path ${absolutePath} does not exist`)
      return false
    }
  }

  /**
   * Marks a configuration as failed with an error message
   */
  private static markConfigFailed(config: BackupConfigState, err: string): void {
    config.status = BackupStatus.ERROR
    config.error = err
    config.errorAtStep = "config"
    error(`[CONFIG] ${err}`)
  }

  /**
   * Loads backup configurations from a specific directory
   */
  private static async loadConfigsFromDir(
    dirPath: string,
    filePattern: string = ".backup.ts",
    requestedNames: Set<string> = new Set(),
  ): Promise<BackupConfigState[]> {
    const backups: BackupConfigState[] = []

    try {
      const entries = Deno.readDirSync(dirPath)

      for (const entry of entries) {
        if (entry.isFile && entry.name.endsWith(filePattern)) {
          const name = entry.name.replace(filePattern, "")
          if (requestedNames.size > 0 && !requestedNames.has(name)) continue
          try {
            const configModule = await import(`${dirPath}/${entry.name}`)

            if (!configModule.default) {
              const backup: BackupConfigState = {
                name,
                sourcePaths: [],
                fileName: entry.name,
                status: BackupStatus.ERROR,
                error: `File ${entry.name} does not export a default BackupConfig`,
                errorAtStep: "config",
              }
              backups.push(backup)
              continue
            }

            const backup: BackupConfigState = {
              ...configModule.default,
              discoveryName: name,
              fileName: entry.name,
              status: BackupStatus.IN_PROGRESS,
            }

            backups.push(backup)
          } catch (error) {
            const backup: BackupConfigState = {
              name,
              sourcePaths: [],
              fileName: entry.name,
              status: BackupStatus.ERROR,
              error: `Failed to load config: ${error}`,
              errorAtStep: "config",
            }
            backups.push(backup)
          }
        } else if (entry.isDirectory) {
          if (requestedNames.size > 0 && !requestedNames.has(entry.name)) continue
          // For stack directories, look for backup.ts inside
          const stackBackupPath = `${dirPath}/${entry.name}/backup.ts`
          try {
            const stat = Deno.statSync(stackBackupPath)
            if (stat.isFile) {
              try {
                const configModule = await import(stackBackupPath)

                if (!configModule.default) {
                  const backup: BackupConfigState = {
                    name: entry.name,
                    sourcePaths: [],
                    fileName: `${entry.name}/backup.ts`,
                    status: BackupStatus.ERROR,
                    error: `File ${entry.name}/backup.ts does not export a default BackupConfig`,
                    errorAtStep: "config",
                  }
                  backups.push(backup)
                  continue
                }

                const backup: BackupConfigState = {
                  ...configModule.default,
                  discoveryName: entry.name,
                  fileName: `${entry.name}/backup.ts`,
                  status: BackupStatus.IN_PROGRESS,
                }

                backups.push(backup)
              } catch (error) {
                const backup: BackupConfigState = {
                  name: entry.name,
                  sourcePaths: [],
                  fileName: `${entry.name}/backup.ts`,
                  status: BackupStatus.ERROR,
                  error: `Failed to load config: ${error}`,
                  errorAtStep: "config",
                }
                backups.push(backup)
              }
            }
          } catch {
            // backup.ts doesn't exist in this stack directory, skip
          }
        }
      }
    } catch (error) {
      // Directory doesn't exist or can't be read, return empty array
      console.warn(`Could not read directory ${dirPath}: ${error}`)
    }

    return backups
  }

  /**
   * Loads all backup configurations from stacks and server configs directories
   */
  static async loadConfigurations(
    stacksPath: string,
    serverConfigsPath: string,
    requestedNames: string[] = [],
  ): Promise<BackupConfigState[]> {
    const backups: BackupConfigState[] = []
    const requested = new Set(requestedNames)

    // Load from stacks directory (each stack may have a backup.ts file)
    const stackBackups = await this.loadConfigsFromDir(stacksPath, "", requested)
    backups.push(...stackBackups)

    // Load from server configs/backup directory (for non-service backups)
    const serverBackups = await this.loadConfigsFromDir(serverConfigsPath, ".backup.ts", requested)
    backups.push(...serverBackups)

    return backups
  }
}
