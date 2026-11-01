import {
  HealthchecksClient,
  type HealthchecksClientOptions,
  HealthchecksOutcome,
  type HealthchecksResult,
} from "@spy4x/integrations/healthchecks"
import { NtfyClient, type NtfyClientConfig, NtfyPriority } from "@spy4x/integrations/ntfy"
import { error, log } from "../../+lib.ts"
import { BackupConfigState, BackupContext, BackupResult, BackupStatus } from "./types.ts"

/** Test seams passed to both notifier clients. Production code passes nothing. */
export interface BackupReporterOptions {
  /** Replaces the global `fetch`. */
  fetcher?: typeof fetch
  /** Replaces the real sleep between retries. */
  sleep?: HealthchecksClientOptions["sleep"]
}

/**
 * The start signal gets a short retry budget: the backup waits for it, and a
 * healthchecks outage must not hold the night's backup back for the default 40 minutes.
 */
const START_SIGNAL_RETRY = { maxAttempts: 3, baseDelayMs: 5_000, totalBudgetMs: 60_000 }

/**
 * Splits `NTFY_URL_BACKUPS`, a full topic URL such as `https://ntfy.example.com/backups`, into
 * the base URL and topic `NtfyClient` takes. A base path in front of the topic is kept, so
 * `https://example.com/ntfy/backups` posts to the same endpoint as before. `null` when the value
 * is not an absolute URL, names no topic, has a broken percent-escape in the topic, or has a query
 * string (`NtfyClient` cannot send one, so `?auth=` would silently be dropped).
 */
export function ntfyConfigFromTopicUrl(topicUrl: string, token: string): NtfyClientConfig | null {
  if (!URL.canParse(topicUrl)) return null
  const url = new URL(topicUrl)
  if (url.search !== "") return null
  const segments = url.pathname.split("/").filter((segment) => segment !== "")
  const topic = segments.pop()
  if (topic === undefined) return null
  const baseUrl = `${url.origin}${segments.map((segment) => `/${segment}`).join("")}`
  let decoded: string
  try {
    decoded = decodeURIComponent(topic)
  } catch {
    return null
  }
  const config = { baseUrl, topic: decoded }
  return token ? { ...config, token } : config
}

export class BackupReporter {
  private healthchecks: HealthchecksClient | null
  private healthchecksStart: HealthchecksClient | null
  private ntfy: NtfyClient | null

  constructor(private context: BackupContext, options: BackupReporterOptions = {}) {
    this.healthchecks = this.createHealthchecks(options)
    this.healthchecksStart = this.createHealthchecks({ ...options, retry: START_SIGNAL_RETRY })
    this.ntfy = this.createNtfy(options)
  }

  /**
   * Sends /start signal to healthchecks to indicate backup has begun
   * This enables Healthchecks to detect if the backup hangs/crashes
   */
  async sendStartSignal(): Promise<void> {
    if (!this.healthchecksStart) return
    log(`Sending healthchecks start signal...`)
    const result = await this.healthchecksStart.ping({
      outcome: HealthchecksOutcome.Start,
      body: `Backup started for ${this.context.serverName}`,
    })
    this.logHealthchecks("start signal", result)
  }

  /**
   * Sends backup notifications via healthchecks and ntfy
   * Healthchecks is used for "dead man's switch" monitoring
   * ntfy is used for direct notifications (failures only)
   */
  async sendNotification(result: BackupResult): Promise<void> {
    await this.sendHealthchecksPing(result)

    const allSuccess = result.successCount === result.totalCount
    if (allSuccess) {
      log("All backups successful, skipping ntfy notification")
      return
    }
    await this.sendNtfyNotification(result)
  }

  /**
   * Builds a healthchecks client, or `null` when no URL is set or it is unusable. A bad URL is
   * logged and skipped, never thrown: a broken notifier must not stop the backup itself. The
   * value is never logged, since a ping URL is the credential.
   */
  private createHealthchecks(
    options: BackupReporterOptions & Pick<HealthchecksClientOptions, "retry">,
  ): HealthchecksClient | null {
    if (!this.context.healthchecksUrl) return null
    try {
      return new HealthchecksClient({ pingUrl: this.context.healthchecksUrl }, options)
    } catch {
      error("HEALTHCHECKS_BACKUP_URL is not a valid URL, skipping healthchecks pings")
      return null
    }
  }

  /** Builds the ntfy client, or `null` (logged, not thrown) when the settings are unusable. */
  private createNtfy(options: BackupReporterOptions): NtfyClient | null {
    if (URL.canParse(this.context.ntfyUrl) && new URL(this.context.ntfyUrl).search !== "") {
      error(
        "NTFY_URL_BACKUPS has a query string, which is not supported; skipping ntfy notifications",
      )
      return null
    }
    const config = ntfyConfigFromTopicUrl(this.context.ntfyUrl, this.context.ntfyAuth)
    if (!config) {
      error("NTFY_URL_BACKUPS is not a topic URL, skipping ntfy notifications")
      return null
    }
    try {
      return new NtfyClient(config, options)
    } catch (err) {
      // NtfyClient's own messages describe the problem without echoing the URL or token.
      error(`ntfy settings rejected, skipping ntfy notifications: ${(err as Error).message}`)
      return null
    }
  }

  /** Logs a healthchecks result. Neither the URL nor a response body is logged. */
  private logHealthchecks(what: string, result: HealthchecksResult): void {
    if (result.ok) {
      log(`healthchecks ${what} sent (attempts: ${result.attempts})`)
    } else {
      error(
        `healthchecks ${what} failed after ${result.attempts} attempts: ${result.code} ${result.message}`,
      )
    }
  }

  /**
   * Pings healthchecks.io-style endpoint
   * Uses /fail suffix if backup failed, otherwise pings success
   */
  private async sendHealthchecksPing(result: BackupResult): Promise<void> {
    if (!this.healthchecks) return
    const allSuccess = result.successCount === result.totalCount
    const outcome = allSuccess ? HealthchecksOutcome.Success : HealthchecksOutcome.Fail
    const ping = await this.healthchecks.ping({
      outcome,
      body: this.buildHealthchecksMessage(result),
    })
    this.logHealthchecks(`ping (${outcome})`, ping)
  }

  /**
   * Builds a detailed message for healthchecks ping body
   * Includes all backup statuses, sizes, durations, and full error details
   */
  private buildHealthchecksMessage(result: BackupResult): string {
    const { backups, successCount, totalCount, totalSizeGB, durationMs } = result
    const successRate = totalCount > 0 ? ((successCount / totalCount) * 100).toFixed(0) : "0"
    const durationMinutes = Math.floor(durationMs / 60000)
    const durationSeconds = Math.floor((durationMs % 60000) / 1000)
    const durationText = durationMinutes > 0
      ? `${durationMinutes}m ${durationSeconds}s`
      : `${durationSeconds}s`

    // Header with summary
    let message = `Server: ${this.context.serverName}\n`
    message += `Success: ${successCount}/${totalCount} (${successRate}%)\n`
    message += `Total Size: ${totalSizeGB.toFixed(2)} GB\n`
    message += `Duration: ${durationText}\n`
    message += "\n"

    // Detailed list of all backups sorted by size
    const sortedBackups = this.sortBackupsBySize(backups, totalSizeGB)
    message += "All Backups:\n"
    message += "Status | Name                 | %     | Size      | Time\n"
    message += "-------|----------------------|-------|-----------|-------\n"

    for (const backup of sortedBackups) {
      const statusSymbol = backup.status === BackupStatus.SUCCESS ? "OK" : "FAIL"
      const name = backup.name.padEnd(20, " ").substring(0, 20)
      const { percentage, size } = this.formatBackupSize(backup, totalSizeGB)
      const duration = this.formatDuration(backup.durationMs)
      message += `${statusSymbol.padEnd(6)} | ${name} | ${percentage} | ${
        size.padEnd(9)
      } | ${duration}\n`
    }

    // Detailed error section if any failures
    const failedBackups = backups.filter((b) => b.status === BackupStatus.ERROR)
    if (failedBackups.length > 0) {
      message += "\nError Details:\n"
      for (const backup of failedBackups) {
        const errorStep = backup.errorAtStep ? `[${backup.errorAtStep.toUpperCase()}]` : ""
        const errorMsg = backup.error || "unknown error"
        message += `- ${backup.name}: ${errorStep} ${errorMsg}\n`
      }
    }

    return message
  }

  /**
   * Sends the failure report via ntfy. The client turns the title into ASCII for the header,
   * retries, and never puts the URL, token or response body in its result.
   */
  private async sendNtfyNotification(result: BackupResult): Promise<void> {
    if (!this.ntfy) return
    const { successCount, totalCount } = result
    const successRate = totalCount > 0 ? ((successCount / totalCount) * 100).toFixed(0) : "0"
    const title =
      `Backup report, server "${this.context.serverName}": ${successCount}/${totalCount} (${successRate}%)`
    const pushed = await this.ntfy.notifyFailure(title, this.buildNtfyMessage(result), {
      priority: NtfyPriority.High,
      tags: ["warning"],
    })
    if (pushed.ok) {
      log(`ntfy notification sent (attempts: ${pushed.attempts})`)
    } else {
      error(
        `ntfy notification failed after ${pushed.attempts} attempts: ${pushed.code} ${pushed.message}`,
      )
    }
  }

  /**
   * Builds the ntfy message body
   */
  private buildNtfyMessage(result: BackupResult): string {
    const { backups, totalSizeGB, durationMs } = result
    const sortedBackups = this.sortBackupsBySize(backups, totalSizeGB)

    // Format duration
    const durationMinutes = Math.floor(durationMs / 60000)
    const durationSeconds = Math.floor((durationMs % 60000) / 1000)
    const durationText = durationMinutes > 0
      ? `${durationMinutes}m ${durationSeconds}s`
      : `${durationSeconds}s`

    // Start with emoji in the message body (not in headers)
    let message = `💾 Total: ${totalSizeGB.toFixed(2)} GB\n⏱️ Duration: ${durationText}\n\n`

    // Add table - limit to top 10 for ntfy to keep message short
    const displayBackups = sortedBackups.slice(0, 10)
    for (const backup of displayBackups) {
      const statusEmoji = backup.status === BackupStatus.SUCCESS ? "✅" : "❌"
      const { size } = this.formatBackupSize(backup, totalSizeGB)
      const duration = this.formatDuration(backup.durationMs)
      message += `${statusEmoji} ${backup.name}: ${size} (${duration})\n`
    }

    // Add indication if there are more backups
    if (sortedBackups.length > 10) {
      message += `\n...and ${sortedBackups.length - 10} more\n`
    }

    // Add errors if any
    const failedBackups = backups.filter((b) => b.status === BackupStatus.ERROR)
    if (failedBackups.length > 0) {
      message += "\n⚠️ Errors:\n"
      for (const backup of failedBackups) {
        if (backup.error) {
          message += `• ${backup.name}: ${backup.error}\n`
        }
      }
    }

    return message
  }

  /**
   * Prints a detailed console report of the backup results
   */
  printConsoleReport(result: BackupResult): void {
    const { backups, successCount, totalCount, totalSizeGB, durationMs } = result

    // Format duration
    const durationMinutes = Math.floor(durationMs / 60000)
    const durationSeconds = Math.floor((durationMs % 60000) / 1000)

    log(`--------- Backups finished: ${successCount} / ${totalCount} successful ---------`)
    log(`Duration: ${durationMinutes}m ${durationSeconds}s`)

    // Print size summary
    this.printSizeSummary(backups, totalSizeGB)

    // Print detailed table
    this.printBackupTable(backups, totalSizeGB)
  }

  /**
   * Prints a summary of backup sizes
   */
  private printSizeSummary(backups: BackupConfigState[], totalSizeGB: number): void {
    const backupsWithSize = backups.filter((b) => b.sizeGB !== undefined)
    const sizeErrors = backups.filter((b) => b.sizeError).length

    if (backupsWithSize.length > 0) {
      log(`Total backup size: ${totalSizeGB.toFixed(2)} GB`)
      if (sizeErrors > 0) {
        log(`Size calculation errors: ${sizeErrors} repositories`)
      }
    } else if (sizeErrors > 0) {
      log(`Size calculation failed for all ${sizeErrors} repositories`)
    }
  }

  /**
   * Prints a formatted table of backup results
   */
  private printBackupTable(backups: BackupConfigState[], totalSizeGB: number): void {
    // Sort backups by percentage descending
    const sortedBackups = this.sortBackupsBySize(backups, totalSizeGB)

    log("Status | Name                 | %     | Size      | Time")
    log("-------|----------------------|-------|-----------|-------")

    for (const backup of sortedBackups) {
      const statusEmoji = backup.status === BackupStatus.SUCCESS ? "✅" : "❌"
      const name = backup.name.padEnd(20, " ").substring(0, 20)
      const { percentage, size } = this.formatBackupSize(backup, totalSizeGB)
      const duration = this.formatDuration(backup.durationMs)

      log(`${statusEmoji}     | ${name} | ${percentage} | ${size.padEnd(9)} | ${duration}`)
    }
  }

  /**
   * Builds the header text for the notification
   */
  private buildHeaderText(
    successCount: number,
    totalCount: number,
    totalSizeGB: number,
    backups: BackupConfigState[],
    durationMs: number,
  ): string {
    const successRate = totalCount > 0 ? ((successCount / totalCount) * 100).toFixed(0) : "0"
    const durationMinutes = Math.floor(durationMs / 60000)
    const durationSeconds = Math.floor((durationMs % 60000) / 1000)
    const durationText = durationMinutes > 0
      ? `${durationMinutes}m ${durationSeconds}s`
      : `${durationSeconds}s`

    let headerText =
      `🏠 Homelab Backup Report\n${successCount}/${totalCount} successful (${successRate}%)\n⏱️ Duration: ${durationText}`

    const sizeErrors = backups.filter((b) => b.sizeError).length

    if (totalSizeGB > 0) {
      headerText += `\n💾 Total: ${totalSizeGB.toFixed(2)} GB`
      if (sizeErrors > 0) {
        headerText += ` (${sizeErrors} size errors)`
      }
    } else if (sizeErrors > 0) {
      headerText += `\n⚠️ Size calculation failed for all repositories`
    }

    return headerText
  }

  /**
   * Builds the table content for the notification
   */
  private buildTableContent(backups: BackupConfigState[], totalSizeGB: number): string {
    const sortedBackups = this.sortBackupsBySize(backups, totalSizeGB)

    let tableContent = "```\n"
    tableContent += "Status | Name                 | %     | Size      | Time\n"
    tableContent += "-------|----------------------|-------|-----------|-------\n"

    for (const backup of sortedBackups) {
      const statusEmoji = backup.status === BackupStatus.SUCCESS ? "✅" : "❌"
      const name = backup.name.padEnd(20, " ").substring(0, 20)
      const { percentage, size } = this.formatBackupSize(backup, totalSizeGB)
      const duration = this.formatDuration(backup.durationMs)

      tableContent += `${statusEmoji}     | ${name} | ${percentage} | ${
        size.padEnd(9)
      } | ${duration}\n`
    }

    tableContent += "```"
    return tableContent
  }

  /**
   * Builds error details section for failed backups
   */
  private buildErrorDetails(backups: BackupConfigState[]): string {
    const failedBackups = backups.filter((backup) => backup.status === BackupStatus.ERROR)

    if (failedBackups.length === 0) {
      return ""
    }

    let errorDetails = "\n*Error Details:*\n"
    for (const backup of failedBackups) {
      if (backup.error) {
        errorDetails +=
          `• *${backup.name}*: [${backup.errorAtStep?.toUpperCase()}] ${backup.error}\n`
      }
    }

    return errorDetails
  }

  /**
   * Sorts backups by size percentage in descending order
   */
  private sortBackupsBySize(
    backups: BackupConfigState[],
    totalSizeGB: number,
  ): BackupConfigState[] {
    return [...backups].sort((a, b) => {
      const aPercent = a.sizeGB !== undefined && totalSizeGB > 0
        ? (a.sizeGB / totalSizeGB) * 100
        : -1
      const bPercent = b.sizeGB !== undefined && totalSizeGB > 0
        ? (b.sizeGB / totalSizeGB) * 100
        : -1
      return bPercent - aPercent
    })
  }

  /**
   * Formats backup size information for display
   */
  private formatBackupSize(
    backup: BackupConfigState,
    totalSizeGB: number,
  ): { percentage: string; size: string } {
    if (backup.sizeGB !== undefined && totalSizeGB > 0) {
      const percent = ((backup.sizeGB / totalSizeGB) * 100).toFixed(1)
      return {
        percentage: `${percent}%`.padEnd(5, " "),
        size: `${backup.sizeGB.toFixed(2)} GB`,
      }
    } else if (backup.sizeGB !== undefined) {
      return {
        percentage: "N/A  ",
        size: `${backup.sizeGB.toFixed(2)} GB`,
      }
    } else if (backup.sizeError) {
      return {
        percentage: "ERR  ",
        size: "Error",
      }
    } else {
      return {
        percentage: "N/A  ",
        size: "N/A",
      }
    }
  }

  /**
   * Formats duration in milliseconds to human-readable string
   */
  private formatDuration(durationMs: number | undefined): string {
    if (durationMs === undefined) {
      return "N/A"
    }

    const seconds = Math.floor(durationMs / 1000)
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60

    if (minutes > 0) {
      return `${minutes}m${remainingSeconds}s`
    } else {
      return `${seconds}s`
    }
  }
}
