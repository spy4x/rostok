import { assertEquals, assertRejects } from "@std/assert"
import { type WaitClock, waitFor } from "./wait.ts"

/** A clock that only moves when the code under test sleeps. */
function fakeClock(): WaitClock & { slept: number[] } {
  let now = 0
  const slept: number[] = []
  return {
    slept,
    now: () => now,
    sleep: (ms) => {
      slept.push(ms)
      now += ms
      return Promise.resolve()
    },
  }
}

Deno.test("returns the probe's value as soon as it has one", async () => {
  const clock = fakeClock()
  let calls = 0
  const value = await waitFor(
    "the server",
    60_000,
    () => Promise.resolve(++calls === 3 ? "192.0.2.1" : undefined),
    undefined,
    clock,
  )
  assertEquals(value, "192.0.2.1")
  assertEquals(clock.slept, [5000, 5000])
})

Deno.test("fails at the deadline and names what it waited for", async () => {
  const clock = fakeClock()
  const err = await assertRejects(
    () => waitFor("SSH on the server", 12_000, () => Promise.resolve(undefined), undefined, clock),
    Error,
  )
  assertEquals(err.message, "gave up after 12 s waiting for SSH on the server")
  assertEquals(clock.slept, [5000, 5000, 5000])
})

Deno.test("a throwing probe counts as not ready, and its last error is reported", async () => {
  const clock = fakeClock()
  let calls = 0
  const err = await assertRejects(
    () =>
      waitFor(
        "Docker",
        5000,
        () => Promise.reject(new Error(`attempt ${++calls}`)),
        undefined,
        clock,
      ),
    Error,
  )
  assertEquals(err.message, "gave up after 5 s waiting for Docker (last error: attempt 2)")
})

Deno.test("stops at once when the run is aborted", async () => {
  const clock = fakeClock()
  const abort = new AbortController()
  let calls = 0
  const err = await assertRejects(
    () =>
      waitFor(
        "the server",
        60_000,
        () => {
          calls++
          abort.abort(new Error("interrupted by SIGINT"))
          return Promise.resolve(undefined)
        },
        abort.signal,
        clock,
      ),
    Error,
  )
  assertEquals(err.message, "interrupted by SIGINT")
  assertEquals(calls, 1)
})
