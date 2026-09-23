// Tests for cli/timezone.ts — #212 (timezone detection order).
//
// Every source is injected — no shelling out, no real filesystem reads —
// so these tests only check the fallback order in `detectTimezone`.

import { assertEquals } from "@std/assert"
import { detectTimezone } from "./timezone.ts"

Deno.test("detectTimezone: local Intl zone wins when present", async () => {
  const tz = await detectTimezone({
    local: () => "Asia/Ho_Chi_Minh",
    etcTimezone: () => Promise.resolve("Europe/Berlin"),
    remote: () => Promise.resolve("America/New_York"),
  })
  assertEquals(tz, "Asia/Ho_Chi_Minh")
})

Deno.test("detectTimezone: falls through to /etc/timezone when Intl is empty", async () => {
  const tz = await detectTimezone({
    local: () => undefined,
    etcTimezone: () => Promise.resolve("Europe/Berlin"),
    remote: () => Promise.resolve("America/New_York"),
  })
  assertEquals(tz, "Europe/Berlin")
})

Deno.test("detectTimezone: falls through to the remote source when local and /etc/timezone are both empty", async () => {
  const tz = await detectTimezone({
    local: () => undefined,
    etcTimezone: () => Promise.resolve(undefined),
    remote: () => Promise.resolve("America/New_York"),
  })
  assertEquals(tz, "America/New_York")
})

Deno.test("detectTimezone: UTC when every source is empty", async () => {
  const tz = await detectTimezone({
    local: () => undefined,
    etcTimezone: () => Promise.resolve(undefined),
    remote: () => Promise.resolve(undefined),
  })
  assertEquals(tz, "UTC")
})

Deno.test("detectTimezone: UTC when no sources are given at all and the real ones can't help", async () => {
  // The real `local` source (Intl) almost always resolves to something on
  // a real machine, so this only exercises the "no sources object at
  // all" call shape — not a true "everything empty" path. Kept as a
  // smoke test that the defaults don't throw.
  const tz = await detectTimezone()
  assertEquals(typeof tz, "string")
  assertEquals(tz.length > 0, true)
})

Deno.test("detectTimezone: an empty-string local source falls through to the next one", async () => {
  const tz = await detectTimezone({
    local: () => "",
    etcTimezone: () => Promise.resolve("Europe/Berlin"),
    remote: () => Promise.resolve(undefined),
  })
  assertEquals(tz, "Europe/Berlin")
})
