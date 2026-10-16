import { assertEquals } from "@std/assert"
import { formatSmartSkipMessage } from "./sudo.ts"

// Ported from scripts/offline-backup: when passwordless sudo is missing,
// the skip message must name the exact smartctl command to run by hand.

Deno.test("formatSmartSkipMessage: names the short test and the device", () => {
  assertEquals(
    formatSmartSkipMessage("short", "/dev/sda")[1],
    "   Run it by hand: sudo smartctl -t short /dev/sda",
  )
})

Deno.test("formatSmartSkipMessage: names the long test and the device", () => {
  assertEquals(
    formatSmartSkipMessage("long", "/dev/nvme0n1")[1],
    "   Run it by hand: sudo smartctl -t long /dev/nvme0n1",
  )
})

Deno.test("formatSmartSkipMessage: first line says why the test was skipped", () => {
  assertEquals(
    formatSmartSkipMessage("short", "/dev/sda")[0],
    "SMART test skipped: sudo needs a password and there is no terminal to type it.",
  )
})
