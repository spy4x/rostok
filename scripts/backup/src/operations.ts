import { absPath, error, log } from "../../+lib.ts"
import { USER } from "./+lib.ts"
import {
  COMPOSE_LABELS_FORMAT,
  composeFileArgs,
  ComposeTarget,
  DEPLOY_ENV_FILE_ARGS,
  hasDeployEnvFiles,
  parseComposeTargets,
  parseUnmatchedStackContainers,
  whyCannotRebuild,
} from "./compose-target.ts"
import { hasNonEmptyResticSubdir } from "./repo-guard.ts"
import {
  BackupConfigState,
  BackupStatus,
  isMissingContainerError,
  ResticCommandOptions,
} from "./types.ts"

export class BackupOperations {
  private backupsPassword: string
  /** Compose target of each stack stopped by this run, keyed by config file name. */
  private composeTargets = new Map<string, ComposeTarget>()

  constructor(backupsPassword: string) {
    this.backupsPassword = backupsPassword
  }

  /**
   * Starts or stops Docker containers for a backup configuration
   */
  async manageContainers(
    config: BackupConfigState,
    action: "start" | "stop",
  ): Promise<void> {
    if (!config.containers?.stop || config.containers.stop.length === 0) {
      return
    }

    // Check if using compose mode (resolved from "stop: default")
    if (config.containers.stop.length === 1 && config.containers.stop[0] === "__compose__") {
      const stackDir = config.fileName?.match(/^(.+)\/backup\.ts$/)?.[1]
      if (!stackDir) {
        // Fall through if there is no stack directory (non-stack config)
        log(`No compose stack found for ${config.name}, skipping container management`)
        return
      }
      await this.manageComposeStack(stackDir, config, action)
      return
    }

    for (const containerName of config.containers.stop) {
      log(`${action}ing container ${containerName}`)

      const cmd = new Deno.Command("docker", {
        args: [action, containerName],
        stdout: "piped",
        stderr: "piped",
      })

      const { code, stderr } = await cmd.output()

      if (code !== 0) {
        const errorMsg = `Error ${action}ing container ${containerName}:\n${
          new TextDecoder().decode(stderr)
        }`
        this.markBackupFailed(config, errorMsg, `docker_${action}`)
        return
      }
    }
  }

  /**
   * Manages a Docker Compose stack (stop/start all services).
   *
   * Stop: finds the stack's running containers and reads their compose labels
   * (project, config files). Those values, not a path built from
   * this runner's `PATH_APPS`, drive stop, start and the `up -d` fallback,
   * because the stack may have been deployed from another directory (#297).
   * With no running container there is nothing to stop and nothing to start
   * afterwards, so no compose command runs and no path is invented.
   *
   * Start: prefer `docker compose start` (fast, no env re-eval, leaves
   * bind mounts alone). Fall back to `docker compose up -d` if `start`
   * fails because a container vanished during the backup window — a
   * common race when Watchtower updates a service mid-backup and
   * removes/recreates the old container. `up -d` is idempotent: it
   * recreates only missing containers and leaves the rest running. It runs
   * from the recorded working dir with the same `--env-file`s as
   * `rostok deploy`; when the compose files or env files are gone it does
   * NOT run, and the backup is reported as failed with the stack stopped.
   * A stopped stack and a red report beat a stack silently rebuilt from
   * wrong config.
   *
   * HOME is forced to the user's real home before `up -d` so that any
   * `~` in bind-mount env vars resolves to /home/<USER>, not /root.
   * (Cron runs the backup as root, which would otherwise redirect
   * bind mounts into /root/ and take the stack down — see git history
   * for the 2026-06-26 all-46-services-down incident.)
   */
  private async manageComposeStack(
    stackDir: string,
    config: BackupConfigState,
    action: "start" | "stop",
  ): Promise<void> {
    let target: ComposeTarget
    if (action === "stop") {
      const found = await this.findRunningTarget(stackDir, config)
      if (!found) return
      this.composeTargets.set(config.fileName, found)
      target = found
    } else {
      const remembered = this.composeTargets.get(config.fileName)
      if (!remembered) return // nothing was stopped, so nothing to start
      target = remembered
    }

    log(`${action}ing compose stack ${target.project} from ${target.appsRoot}`)
    const baseArgs = ["compose", "-p", target.project, ...composeFileArgs(target)]
    // Compose interpolates the files even for stop/start, and stacks use required
    // variables (`${X:?}`), so pass the deploy env files whenever they exist.
    const envArgs = await hasDeployEnvFiles(target) ? DEPLOY_ENV_FILE_ARGS : []

    const { code, stderr } = await new Deno.Command("docker", {
      args: [...baseArgs, ...envArgs, action],
      cwd: target.appsRoot,
      stdout: "piped",
      stderr: "piped",
    }).output()

    if (code === 0) {
      return
    }

    const errStr = new TextDecoder().decode(stderr)

    // Only retry for start. Stop failures are real (compose file gone,
    // project name typo, daemon down) — don't paper over them.
    if (action === "start" && isMissingContainerError(errStr)) {
      log(
        `start failed (missing container), falling back to up -d:\n${errStr.trim()}`,
      )
      const reason = await whyCannotRebuild(target)
      if (reason) {
        this.markBackupFailed(
          config,
          `Stack ${target.project} is left stopped: start failed (${errStr.trim()}) and up -d ` +
            `cannot reproduce the deployed config (${reason})`,
          `compose_${action}`,
        )
        return
      }
      const fallback = new Deno.Command("docker", {
        args: [...baseArgs, ...DEPLOY_ENV_FILE_ARGS, "up", "-d"],
        cwd: target.appsRoot,
        env: {
          ...Deno.env.toObject(),
          HOME: `/home/${USER}`,
        },
        stdout: "piped",
        stderr: "piped",
      })
      const { code: upCode, stderr: upStderr } = await fallback.output()
      if (upCode !== 0) {
        const upErrStr = new TextDecoder().decode(upStderr)
        this.markBackupFailed(
          config,
          `Error ${action}ing compose stack (start failed: ${errStr}; up -d also failed: ${upErrStr})`,
          `compose_${action}`,
        )
        return
      }
      log("up -d fallback succeeded")
      return
    }

    this.markBackupFailed(
      config,
      `Error ${action}ing compose stack:\n${errStr}`,
      `compose_${action}`,
    )
  }

  /**
   * Reads the compose labels of the stack's running containers. Returns null
   * (after logging, or marking the backup failed) when there is nothing to stop.
   */
  private async findRunningTarget(
    stackDir: string,
    config: BackupConfigState,
  ): Promise<ComposeTarget | null> {
    const { code, stdout, stderr } = await new Deno.Command("docker", {
      args: [
        "ps",
        "--filter",
        "label=com.docker.compose.project",
        "--format",
        COMPOSE_LABELS_FORMAT,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output()
    if (code !== 0) {
      this.markBackupFailed(
        config,
        `Error listing running containers:\n${new TextDecoder().decode(stderr)}`,
        "compose_stop",
      )
      return null
    }
    const out = new TextDecoder().decode(stdout)
    const { targets, conflicts } = parseComposeTargets(out, stackDir)
    if (conflicts.length > 0) {
      this.markBackupFailed(config, conflicts.join("\n"), "compose_stop")
      return null
    }
    const unmatched = parseUnmatchedStackContainers(out, stackDir)
    if (targets.length === 0 && unmatched.length > 0) {
      this.markBackupFailed(
        config,
        `Running containers of compose project ${unmatched.join(", ")} look like stack ` +
          `${stackDir}, but none was created from .../stacks/${stackDir}/compose.yml, so the ` +
          `stack was not stopped and would be copied live. Fix the deploy layout or the backup config.`,
        "compose_stop",
      )
      return null
    }
    if (targets.length === 0) {
      log(`No running containers for stack ${stackDir}, skipping container management`)
      return null
    }
    if (targets.length > 1) {
      this.markBackupFailed(
        config,
        `Stack ${stackDir} runs from ${targets.length} different compose projects ` +
          `(${targets.map((t) => `${t.project} in ${t.appsRoot}`).join(", ")}); ` +
          `refusing to guess which to stop`,
        "compose_stop",
      )
      return null
    }
    return targets[0]
  }

  /**
   * Changes ownership of specified paths to the current user
   */
  async changeOwnership(config: BackupConfigState): Promise<void> {
    if (!config.pathsToChangeOwnership || config.pathsToChangeOwnership.length === 0) {
      return
    }

    for (const path of config.pathsToChangeOwnership) {
      const absolutePath = absPath(path, USER)
      log(`Changing ownership of ${absolutePath} to ${USER}:${USER}`)

      const cmd = new Deno.Command("sudo", {
        args: ["chown", "-R", `${USER}:${USER}`, absolutePath],
        stdout: "piped",
        stderr: "piped",
      })

      const { code, stderr } = await cmd.output()

      if (code !== 0) {
        const errorMsg = `Error changing ownership of ${path}:\n${new TextDecoder().decode(stderr)}`
        this.markBackupFailed(config, errorMsg, "chown")
        return
      }
    }

    log("Ownership changed successfully")
  }

  /**
   * Performs the complete restic backup process
   */
  async performResticBackup(
    config: BackupConfigState,
    backupsOutputBasePath: string,
  ): Promise<void> {
    if (config.status === BackupStatus.ERROR) {
      return
    }

    const destName = config.destName || config.name
    const repoPath = absPath(`${backupsOutputBasePath}/${destName}`, USER)

    // Check if repository exists and initialize if needed
    if (!(await this.ensureRepository(config, repoPath))) {
      return
    }

    // Verify integrity before backup
    if (
      !(await this.runResticCommand({
        args: ["check", "-r", repoPath],
        config,
        step: "check_integrity_before",
      }))
    ) {
      return
    }

    // Perform backup
    const backupArgs = [
      "backup",
      ...((config.sourcePaths as string[]).map((path) => absPath(path, USER))),
      "-r",
      repoPath,
    ]
    if (!(await this.runResticCommand({ args: backupArgs, config, step: "backup" }))) {
      return
    }

    // Clean up old backups
    const forgetArgs = [
      "forget",
      "--prune",
      "--keep-daily", // last 7 daily backups
      "7",
      "--keep-weekly", // last 4 weekly backups
      "4",
      "--keep-monthly", // last 3 monthly backups
      "3",
      "--group-by",
      "paths,tags", // group by paths and tags to avoid treating different hosts as separate backups (i.e. when hostname changes)
      "-r",
      repoPath,
    ]
    if (!(await this.runResticCommand({ args: forgetArgs, config, step: "forget" }))) {
      return
    }

    // Verify integrity after backup
    if (
      !(await this.runResticCommand({
        args: ["check", "-r", repoPath],
        config,
        step: "check_integrity_after",
      }))
    ) {
      return
    }

    // Fix repository ownership for Syncthing sync
    // The cron job runs as root, so repos are created with root ownership
    // Change to user ownership so Syncthing can sync them
    await this.changeRepoOwnership(repoPath)
  }

  /**
   * Changes ownership of the backup repository to allow Syncthing sync
   */
  async changeRepoOwnership(repoPath: string): Promise<void> {
    log(`Changing repository ownership to ${USER}:${USER}`)

    const cmd = new Deno.Command("sudo", {
      args: ["chown", "-R", `${USER}:${USER}`, repoPath],
      stdout: "piped",
      stderr: "piped",
    })

    const { code, stderr } = await cmd.output()

    if (code !== 0) {
      const errorMsg = `Warning: Could not change repository ownership:\n${
        new TextDecoder().decode(stderr)
      }`
      error(errorMsg)
      // Don't fail the backup for this, just warn
    } else {
      log("Repository ownership changed successfully")
    }
  }

  /**
   * Ensures the restic repository exists, initializing it if necessary
   */
  private async ensureRepository(config: BackupConfigState, repoPath: string): Promise<boolean> {
    // Try to check if repository exists
    const checkResult = await this.runResticCommand({
      args: ["-r", repoPath, "cat", "config"],
      config,
      step: "check",
    })

    if (checkResult) {
      return true
    }

    // Check if error indicates missing repository
    const lastError = config.error || ""
    const isMissingRepo = lastError.includes("is not a restic repository") ||
      lastError.includes("does not exist") ||
      lastError.includes("no such file or directory")

    if (!isMissingRepo) {
      return false
    }

    // Guard against silent re-init: an earlier incarnation's `keys/`,
    // `data/`, `index/`, or `snapshots/` left behind at this path means
    // the directory already holds restic artefacts. Re-running `init`
    // here would write a new `config` next to an orphan key file whose
    // master key no longer matches it, producing a repo that fails
    // every subsequent `check` with "config or key <id> is damaged:
    // ciphertext verification failed" (restic does not try the
    // remaining keys). Refuse and point the operator at the recovery
    // flow, which removes the directory before init.
    if (await hasNonEmptyResticSubdir(repoPath)) {
      const msg = `Refusing to re-initialize non-empty restic directory ${repoPath}. ` +
        `The path already contains keys/, data/, index/, or snapshots/ ` +
        `from an earlier repository incarnation. Run the recovery flow ` +
        `(scripts/backup/recover.ts) to clear the directory before init.`
      this.markBackupFailed(config, msg, "init")
      return false
    }

    // Initialize repository
    log(`Restic repo does not exist at ${repoPath}, initializing...`)
    config.error = `Restic repo does not exist at ${repoPath}, will initialize it.`

    if (!(await this.runResticCommand({ args: ["init", "-r", repoPath], config, step: "init" }))) {
      return false
    }

    // Clear transient error from failed repo check — init succeeded
    config.status = BackupStatus.IN_PROGRESS
    config.error = undefined
    config.errorAtStep = undefined

    // Verify repository was created successfully
    return await this.runResticCommand({
      args: ["-r", repoPath, "cat", "config"],
      config,
      step: "check",
    })
  }

  /**
   * Runs a restic command and handles the response
   */
  private async runResticCommand(options: ResticCommandOptions): Promise<boolean> {
    const { args, config, step } = options

    const cmd = new Deno.Command("restic", {
      args,
      stdout: "piped",
      stderr: "piped",
      env: {
        ...Deno.env.toObject(),
        RESTIC_PASSWORD: this.backupsPassword,
      },
    })

    const { code, stdout, stderr } = await cmd.output()
    const outStr = new TextDecoder().decode(stdout)
    const errStr = new TextDecoder().decode(stderr)

    if (code === 0) {
      log(`Restic ${step} succeeded`)
      return true
    }

    // Handle different restic exit codes
    const errorMsg = this.getResticErrorMessage(code, errStr, outStr)
    this.markBackupFailed(config, `${errorMsg} ${errStr}`, `restic_${step}`)
    return false
  }

  /**
   * Gets a human-readable error message for restic exit codes
   */
  private getResticErrorMessage(code: number, errStr: string, outStr: string): string {
    const baseError = errStr || outStr || `Restic exited with code ${code}`

    switch (code) {
      case 1:
        return baseError || "Restic command failed (code 1)"
      case 2:
        return "Go runtime error (code 2)"
      case 3:
        return "Backup could not read some source data (code 3)"
      case 10:
        return "Repository does not exist (code 10)"
      case 11:
        return "Failed to lock repository (code 11)"
      case 12:
        return "Wrong password for repository (code 12)"
      case 130:
        return "Restic was interrupted (code 130)"
      default:
        return baseError || `Restic failed with exit code ${code}`
    }
  }

  /**
   * Calculates the size of backup repositories
   */
  async calculateRepositorySizes(
    backups: BackupConfigState[],
    backupsOutputBasePath: string,
  ): Promise<void> {
    for (const backup of backups) {
      try {
        const destName = backup.destName || backup.name
        const repoPath = absPath(`${backupsOutputBasePath}/${destName}`, USER)

        // Check if repository directory exists
        if (!(await this.isValidRepository(backup, repoPath))) {
          continue
        }

        // Calculate directory size using du command
        const sizeBytes = await this.getDirectorySize(repoPath)
        if (sizeBytes === null) {
          backup.sizeError = "Failed to calculate directory size"
          error(`Repository ${backup.name}: failed to calculate size`)
          continue
        }

        // Convert bytes to GB
        backup.sizeGB = sizeBytes / (1024 * 1024 * 1024)
        log(`Repository ${backup.name}: ${backup.sizeGB.toFixed(2)} GB`)
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        backup.sizeError = `Unexpected error: ${errorMsg}`
        error(`Repository ${backup.name}: unexpected error calculating size - ${errorMsg}`)
      }
    }
  }

  /**
   * Checks if a repository path is valid
   */
  private async isValidRepository(backup: BackupConfigState, repoPath: string): Promise<boolean> {
    try {
      const stat = Deno.statSync(repoPath)
      if (!stat.isDirectory) {
        backup.sizeError = "Not a directory"
        error(`Repository ${backup.name}: path exists but is not a directory`)
        return false
      }
      return true
    } catch {
      backup.sizeError = "Repository not found"
      error(`Repository ${backup.name}: directory does not exist at ${repoPath}`)
      return false
    }
  }

  /**
   * Gets the size of a directory in bytes using du command
   */
  private async getDirectorySize(path: string): Promise<number | null> {
    const cmd = new Deno.Command("du", {
      args: ["-sb", path], // -s for summary, -b for bytes
      stdout: "piped",
      stderr: "piped",
    })

    const { code, stdout, stderr } = await cmd.output()

    if (code !== 0) {
      const errorMsg = new TextDecoder().decode(stderr)
      error(`du command failed: ${errorMsg}`)
      return null
    }

    const output = new TextDecoder().decode(stdout).trim()
    const sizeBytes = parseInt(output.split("\t")[0])

    if (isNaN(sizeBytes)) {
      error(`Could not parse size from du output: ${output}`)
      return null
    }

    return sizeBytes
  }

  /**
   * Marks a backup as failed with error details
   */
  private markBackupFailed(backup: BackupConfigState, err: string, step: string): void {
    backup.status = BackupStatus.ERROR
    backup.error = err
    backup.errorAtStep = step
    error(`[${step.toUpperCase()}] ${err}`)
  }
}
