// Tests for cli/timezone.ts — #212 (timezone detection order).
//
// Every source is injected — no shelling out, no real filesystem reads —
// so these tests only check the fallback order in `detectTimezone`.
// TIMEZONE configures containers running *on the server*, so the
// server's own zone (the `remote` source) wins over the operator's
// local machine whenever it's knowable.

import { assertEquals } from "@std/assert"
import { detectTimezone } from "./timezone.ts"

Deno.test("detectTimezone: the remote (server) zone wins over a different local zone", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve("Asia/Ho_Chi_Minh"),
    local: () => "Europe/Berlin",
    etcTimezone: () => Promise.resolve("America/New_York"),
  })
  assertEquals(tz, "Asia/Ho_Chi_Minh")
})

Deno.test("detectTimezone: an unreachable probe (remote returns undefined) falls back to the local zone", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve(undefined),
    local: () => "Europe/Berlin",
    etcTimezone: () => Promise.resolve("America/New_York"),
  })
  assertEquals(tz, "Europe/Berlin")
})

Deno.test("detectTimezone: falls through to /etc/timezone when remote and local Intl are both empty", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve(undefined),
    local: () => undefined,
    etcTimezone: () => Promise.resolve("America/New_York"),
  })
  assertEquals(tz, "America/New_York")
})

Deno.test("detectTimezone: UTC when every source is empty", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve(undefined),
    local: () => undefined,
    etcTimezone: () => Promise.resolve(undefined),
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

Deno.test("detectTimezone: an empty-string remote source falls through to local", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve(""),
    local: () => "Europe/Berlin",
    etcTimezone: () => Promise.resolve(undefined),
  })
  assertEquals(tz, "Europe/Berlin")
})

Deno.test("detectTimezone: a whitespace-only remote answer counts as empty, not a value", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve("   "),
    local: () => "Europe/Berlin",
    etcTimezone: () => Promise.resolve(undefined),
  })
  assertEquals(tz, "Europe/Berlin")
})

// A malformed/garbage remote answer (e.g. a shell profile printing a
// banner before timedatectl's own output landed on stdout) must not be
// accepted as TIMEZONE's value — it should fall through exactly like an
// empty answer.
Deno.test("detectTimezone: an invalid IANA name from the remote source is rejected, falls through", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve("Not/A/Real/Zone"),
    local: () => "Europe/Berlin",
    etcTimezone: () => Promise.resolve(undefined),
  })
  assertEquals(tz, "Europe/Berlin")
})

Deno.test("detectTimezone: an invalid IANA name from /etc/timezone is rejected, falls back to UTC", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve(undefined),
    local: () => undefined,
    etcTimezone: () => Promise.resolve("garbage-not-a-zone"),
  })
  assertEquals(tz, "UTC")
})

Deno.test("detectTimezone: a valid zone from /etc/timezone is accepted", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve(undefined),
    local: () => undefined,
    etcTimezone: () => Promise.resolve("Europe/Berlin"),
  })
  assertEquals(tz, "Europe/Berlin")
})
