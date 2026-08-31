import { assertEquals } from "@std/assert"
import { BackupReporter } from "./reporting.ts"
import { type BackupContext, type BackupResult, BackupStatus } from "./types.ts"

const sensitiveMarker = "SENSITIVE_MARKER"

function context(): BackupContext {
  return {
    serverName: sensitiveMarker,
    backupsOutputBasePath: "/tmp/backups",
    backupsPassword: sensitiveMarker,
    ntfyUrl: "https://notify.example.test/topic",
    ntfyAuth: sensitiveMarker,
    stacksPath: "/tmp/stacks",
    configsPath: "/tmp/configs",
    healthchecksUrl: "https://health.example.test/check",
  }
}

function result(): BackupResult {
  return {
    backups: [{
      name: "home-assistant",
      sourcePaths: [],
      fileName: "home-assistant/backup.ts",
      status: BackupStatus.ERROR,
      error: `${sensitiveMarker} /private/source/path`,
      errorAtStep: "restic_backup",
    }],
    successCount: 0,
    totalCount: 1,
    totalSizeGB: 0,
    durationMs: 1,
  }
}

Deno.test("outbound reports exclude identity and raw errors", () => {
  const reporter = new BackupReporter(context()) as unknown as {
    buildHealthchecksMessage(result: BackupResult): string
    buildNtfyMessage(result: BackupResult): string
  }
  const messages = [
    reporter.buildHealthchecksMessage(result()),
    reporter.buildNtfyMessage(result()),
  ].join("\n")

  assertEquals(messages.includes(sensitiveMarker), false)
  assertEquals(messages.includes("/private/source/path"), false)
  assertEquals(messages.includes("RESTIC_BACKUP"), true)
})

Deno.test("healthcheck fetch failures log static message only", async () => {
  const originalFetch = globalThis.fetch
  const originalError = console.error
  const errors: string[] = []
  globalThis.fetch = () => {
    throw new Error(sensitiveMarker)
  }
  console.error = (...args: unknown[]) => errors.push(args.join(" "))

  try {
    await new BackupReporter(context()).sendStartSignal()
    const output = errors.join("\n")
    assertEquals(output.includes(sensitiveMarker), false)
    assertEquals(output.includes("health.example.test"), false)
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
  }
})
