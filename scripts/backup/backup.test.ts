import { assertEquals } from "@std/assert"
import { BackupStatus } from "./src/types.ts"

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
