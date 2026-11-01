import { assert, assertEquals } from "@std/assert"
import {
  CHECK_INTERVAL_MS,
  checkForUpdate,
  isDue,
  parseState,
  shouldCheck,
  startUpdateCheck,
  statePath,
  type UpdateCheckDeps,
  updateNotice,
} from "./update-check.ts"

const NOW = Date.UTC(2026, 10, 1, 12)
const STATE = "/cache/rostok/update-check.json"

/** Deps over an in-memory state file; `calls` counts network requests. */
function fakeDeps(
  initial: string | undefined,
  fetchLatest: UpdateCheckDeps["fetchLatest"] = () => Promise.resolve("1.24.0"),
) {
  const files = new Map<string, string>()
  if (initial !== undefined) files.set(STATE, initial)
  const calls = { n: 0 }
  const deps: UpdateCheckDeps = {
    now: () => NOW,
    currentVersion: "1.23.0",
    statePath: STATE,
    fetchLatest: (signal) => {
      calls.n++
      return fetchLatest(signal)
    },
    readText: (path) => {
      const text = files.get(path)
      return text === undefined ? Promise.reject(new Deno.errors.NotFound()) : Promise.resolve(text)
    },
    writeText: (path, text) => {
      files.set(path, text)
      return Promise.resolve()
    },
  }
  return { deps, files, calls }
}

Deno.test("shouldCheck skips upgrade, version, help, CI, opt-out and a non-terminal", () => {
  const env = (vars: Record<string, string>) => (key: string) => vars[key]
  const none = env({})
  assertEquals(shouldCheck(["stack", "list"], none, true), true)
  assertEquals(shouldCheck([], none, true), true)
  assertEquals(shouldCheck(["upgrade"], none, true), false)
  assertEquals(shouldCheck(["update", "1.0.0"], none, true), false)
  assertEquals(shouldCheck(["__run-hook", "file:///x.ts"], none, true), false)
  assertEquals(shouldCheck(["--version"], none, true), false)
  assertEquals(shouldCheck(["deploy", "--help"], none, true), false)
  assertEquals(shouldCheck(["-h"], none, true), false)
  assertEquals(shouldCheck(["stack", "list"], none, false), false)
  assertEquals(shouldCheck(["stack", "list"], env({ CI: "true" }), true), false)
  assertEquals(shouldCheck(["stack", "list"], env({ ROSTOK_NO_UPDATE_CHECK: "1" }), true), false)
})

Deno.test("isDue allows one network check per 24 hours", () => {
  assertEquals(isDue(undefined, NOW), true)
  assertEquals(isDue({ checkedAt: NOW - CHECK_INTERVAL_MS + 60_000 }, NOW), false)
  assertEquals(isDue({ checkedAt: NOW - CHECK_INTERVAL_MS }, NOW), true)
  // A clock set back must not silence the check for good.
  assertEquals(isDue({ checkedAt: NOW + 60_000 }, NOW), true)
})

Deno.test("updateNotice names the newer version and is silent otherwise", () => {
  assertEquals(
    updateNotice("1.23.0", "1.24.0"),
    "rostok 1.24.0 is available (you have 1.23.0). Run: rostok upgrade",
  )
  assertEquals(updateNotice("1.23.0", "1.23.0"), undefined)
  assertEquals(updateNotice("1.23.0", "1.9.0"), undefined)
  assertEquals(updateNotice("1.23.0", undefined), undefined)
})

Deno.test("statePath prefers XDG_CACHE_HOME, then ~/.cache, else none", () => {
  assertEquals(
    statePath((k) => ({ XDG_CACHE_HOME: "/x", HOME: "/h" } as Record<string, string>)[k]),
    "/x/rostok/update-check.json",
  )
  assertEquals(
    statePath((k) => ({ HOME: "/h" } as Record<string, string>)[k]),
    "/h/.cache/rostok/update-check.json",
  )
  assertEquals(statePath(() => undefined), undefined)
})

Deno.test("parseState treats a corrupt state file as no state", () => {
  assertEquals(parseState("{not json"), undefined)
  assertEquals(parseState(`{"checkedAt":"yesterday"}`), undefined)
  assertEquals(parseState(`{"checkedAt":5,"latest":"1.2.3"}`), { checkedAt: 5, latest: "1.2.3" })
})

Deno.test("checkForUpdate within 24 hours uses the saved version without the network", async () => {
  const saved = JSON.stringify({ checkedAt: NOW - 60_000, latest: "1.25.0" })
  const { deps, calls } = fakeDeps(saved)
  const notice = await checkForUpdate(deps, new AbortController().signal)
  assertEquals(calls.n, 0)
  assertEquals(notice, "rostok 1.25.0 is available (you have 1.23.0). Run: rostok upgrade")
})

Deno.test("checkForUpdate after 24 hours asks the network and saves the answer", async () => {
  const saved = JSON.stringify({ checkedAt: NOW - CHECK_INTERVAL_MS, latest: "1.23.0" })
  const { deps, files, calls } = fakeDeps(saved)
  const notice = await checkForUpdate(deps, new AbortController().signal)
  assertEquals(calls.n, 1)
  assertEquals(JSON.parse(files.get(STATE)!), { checkedAt: NOW, latest: "1.24.0" })
  assertEquals(notice, "rostok 1.24.0 is available (you have 1.23.0). Run: rostok upgrade")
})

Deno.test("checkForUpdate with the network down is silent and waits a day to retry", async () => {
  const { deps, files, calls } = fakeDeps(undefined, () => Promise.reject(new TypeError("dns")))
  assertEquals(await checkForUpdate(deps, new AbortController().signal), undefined)
  assertEquals(calls.n, 1)
  assertEquals(JSON.parse(files.get(STATE)!), { checkedAt: NOW })
  assertEquals(await checkForUpdate(deps, new AbortController().signal), undefined)
  assertEquals(calls.n, 1)
})

Deno.test("checkForUpdate cut short by the command finishing still counts for the day", async () => {
  const controller = new AbortController()
  const { deps, files, calls } = fakeDeps(undefined, (signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason))
      // The request is in flight; now the command finishes.
      controller.abort()
    }))
  assertEquals(await checkForUpdate(deps, controller.signal), undefined)
  assertEquals(JSON.parse(files.get(STATE)!), { checkedAt: NOW })
  assertEquals(await checkForUpdate(deps, new AbortController().signal), undefined)
  assertEquals(calls.n, 1)
})

Deno.test("finish waits only briefly for a hanging check and prints nothing", async () => {
  let aborted = false
  const { deps } = fakeDeps(undefined, (signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true
        reject(signal.reason)
      })
    }))
  const printed: string[] = []
  const check = startUpdateCheck(deps, (line) => printed.push(line))
  const started = performance.now()
  await check.finish(50)
  assert(performance.now() - started < 1000, "finish must not wait for the network")
  assertEquals(aborted, true)
  assertEquals(printed, [])
})

Deno.test("finish prints the notice once the check is done", async () => {
  const { deps } = fakeDeps(undefined)
  const printed: string[] = []
  const check = startUpdateCheck(deps, (line) => printed.push(line))
  await check.finish(1000)
  assertEquals(printed, ["rostok 1.24.0 is available (you have 1.23.0). Run: rostok upgrade"])
})
