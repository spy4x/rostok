import { assertEquals } from "@std/assert"
import { formatSmartSkipMessage } from "./verify.ts"

Deno.test({
  // Regression for the 2026-08 SMART hang: when passwordless sudo is
  // unavailable, the skip message must point the operator at the right
  // manual `smartctl -t <type> <device>` invocation for both `short`
  // and `long`. A wrong type or missing device would send them after
  // a phantom command and silently drop the health check.
  name: "formatSmartSkipMessage uses 'short' when checkType is 'short'",
  fn() {
    const lines = formatSmartSkipMessage("short", "/dev/sda")
    assertEquals(lines.length, 2)
    assertEquals(
      lines[1],
      "   Run manually with: sudo smartctl -t short /dev/sda",
    )
  },
})

Deno.test({
  name: "formatSmartSkipMessage uses 'long' when checkType is 'long'",
  fn() {
    const lines = formatSmartSkipMessage("long", "/dev/nvme0n1")
    assertEquals(lines.length, 2)
    assertEquals(
      lines[1],
      "   Run manually with: sudo smartctl -t long /dev/nvme0n1",
    )
  },
})

Deno.test({
  name: "formatSmartSkipMessage first line is the skip warning",
  fn() {
    const lines = formatSmartSkipMessage("short", "/dev/sda")
    assertEquals(
      lines[0],
      "\n⚠️  SMART test skipped — passwordless sudo is unavailable in this session.",
    )
  },
})

Deno.test({
  // The whole rest of the skip path (sudo -n true, the actual
  // smartctl call, the 4-minute wait) is I/O that requires root and
  // a real drive — verified manually by running offline-backup against
  // an external drive. No fake/tautological tests added for those.
  name: "formatSmartSkipMessage message contract is two non-empty lines",
  fn() {
    const lines = formatSmartSkipMessage("short", "/dev/sda")
    assertEquals(lines.length, 2)
    assertEquals(lines.every((l) => l.length > 0), true)
  },
})
