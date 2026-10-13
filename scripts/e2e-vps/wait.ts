/** Clock and sleep, injected so the tests run without real time. */
export interface WaitClock {
  now: () => number
  sleep: (ms: number) => Promise<void>
}

const realClock: WaitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/**
 * Polls `probe` until it returns a value, and fails at the deadline with what it waited for.
 * A probe that throws counts as "not yet"; its last error is added to the failure message.
 *
 * @param what What the run is waiting for, as the failure message will name it.
 * @param deadlineMs How long to wait in total.
 * @param probe Returns the result once ready, `undefined` until then.
 * @param signal Aborts the wait at once, with the signal's reason.
 */
export async function waitFor<T>(
  what: string,
  deadlineMs: number,
  probe: () => Promise<T | undefined>,
  signal?: AbortSignal,
  clock: WaitClock = realClock,
  intervalMs = 5000,
): Promise<T> {
  const start = clock.now()
  let last = ""
  for (;;) {
    signal?.throwIfAborted()
    try {
      const result = await probe()
      if (result !== undefined) return result
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    if (clock.now() - start >= deadlineMs) {
      throw new Error(
        `gave up after ${Math.round(deadlineMs / 1000)} s waiting for ${what}` +
          (last ? ` (last error: ${last})` : ""),
      )
    }
    await clock.sleep(intervalMs)
  }
}
