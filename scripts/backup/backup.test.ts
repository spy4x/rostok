import { assertEquals } from "@std/assert"
import { BackupStatus, isMissingContainerError } from "./src/types.ts"

Deno.test({
  name: "BackupStatus enum starts at 1, increments by 1",
  fn() {
    assertEquals(BackupStatus.IN_PROGRESS, 1)
    assertEquals(BackupStatus.SUCCESS, 2)
    assertEquals(BackupStatus.ERROR, 3)
  },
})

Deno.test({
  name: "BackupStatus enum has no gaps or duplicates",
  fn() {
    const values = Object.values(BackupStatus).filter((v) => typeof v === "number")
    assertEquals(values.length, 3)
    assertEquals(values, [1, 2, 3])
  },
})

Deno.test({
  name: "BackupStatus enum has IN_PROGRESS before SUCCESS before ERROR",
  fn() {
    // Ordering matters for state machine transitions
    assertEquals(BackupStatus.IN_PROGRESS < BackupStatus.SUCCESS, true)
    assertEquals(BackupStatus.SUCCESS < BackupStatus.ERROR, true)
  },
})

Deno.test({
  name: "isMissingContainerError matches compose 'no container to start' stderr",
  fn() {
    // Reproduces the 2026-09-05 cloud-server stalwart backup failure,
    // where Watchtower recreated `hl-cert-sync` between backup's stop
    // and start, leaving docker compose with nothing to restart.
    const stderr = `service "cert-sync" has no container to start`
    assertEquals(isMissingContainerError(stderr), true)
  },
})

Deno.test({
  name: "isMissingContainerError matches when error is wrapped in other text",
  fn() {
    const stderr = [
      "Error starting compose stack:",
      'service "cert-sync" has no container to start',
      "",
    ].join("\n")
    assertEquals(isMissingContainerError(stderr), true)
  },
})

Deno.test({
  name: "isMissingContainerError returns false for unrelated stderr",
  fn() {
    assertEquals(isMissingContainerError(""), false)
    assertEquals(isMissingContainerError("permission denied"), false)
    assertEquals(isMissingContainerError("cannot connect to Docker daemon"), false)
    assertEquals(isMissingContainerError("compose file not found"), false)
  },
})

Deno.test({
  name: "restore.ts never reads the legacy USER key — only SSH_USER",
  async fn() {
    const text = await Deno.readTextFile(new URL("./restore.ts", import.meta.url))
    assertEquals(/getEnvVar\(\s*["']USER["']/.test(text), false)
  },
})
