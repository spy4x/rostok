import { assertEquals } from "@std/assert"
import { shouldRunSmartTest } from "./verify.ts"

Deno.test({
  // Regression for the 2026-08 SMART hang: when sudo has no password in
  // the session, runSmartCheck must skip immediately instead of waiting
  // for a credential it cannot enter (no TTY in non-interactive runs).
  name: "shouldRunSmartTest returns true only when preflight succeeded",
  fn() {
    assertEquals(shouldRunSmartTest(true), true)
  },
})

Deno.test({
  name: "shouldRunSmartTest returns false on any preflight failure",
  fn() {
    assertEquals(shouldRunSmartTest(false), false)
  },
})
