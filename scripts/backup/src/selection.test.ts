import { assertEquals, assertThrows } from "@std/assert"
import { selectBackupConfigurations } from "./selection.ts"
import { type BackupConfigState, BackupStatus } from "./types.ts"

function backup(name: string): BackupConfigState {
  return {
    name,
    sourcePaths: "default",
    fileName: `${name}/backup.ts`,
    status: BackupStatus.IN_PROGRESS,
  }
}

Deno.test("returns every backup when no names are requested", () => {
  const backups = [backup("home-assistant"), backup("vaultwarden")]

  assertEquals(selectBackupConfigurations(backups, []), backups)
})

Deno.test("selects requested backups in discovery order", () => {
  const backups = [backup("home-assistant"), backup("vaultwarden"), backup("gatus")]

  assertEquals(
    selectBackupConfigurations(backups, ["gatus", "home-assistant"]),
    [backups[0], backups[2]],
  )
})

Deno.test("rejects unknown backup names", () => {
  const backups = [backup("home-assistant")]

  assertThrows(
    () => selectBackupConfigurations(backups, ["missing"]),
    Error,
    "Unknown backup configuration: missing",
  )
})

Deno.test("selects by trusted discovery name", () => {
  const config = backup("exported-name")
  config.discoveryName = "stack-directory"

  assertEquals(selectBackupConfigurations([config], ["stack-directory"]), [config])
})
