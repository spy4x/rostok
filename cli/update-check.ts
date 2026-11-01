// Background update check: once a day at most, rostok asks GitHub for the latest release while
// the command runs, and prints one line after the command's own output when a newer one exists.
//
// It never slows a command down: the network gets 3 seconds, the command waits for the result at
// most {@link NOTICE_WAIT_MS} after it finished, and every failure is silent.

import { join } from "@std/path"
import { compareVersions, fetchLatestVersion, normalizeVersion, releasesUrl } from "./upgrade.ts"
import { NAME, VERSION } from "./version.ts"

/** The network is asked at most once per this many milliseconds. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Time the GitHub request gets before it is dropped. */
export const FETCH_TIMEOUT_MS = 3000
/** How long a finished command waits for a check still running. */
export const NOTICE_WAIT_MS = 300

/** What `update-check.json` holds. */
export interface UpdateCheckState {
  /** When the network was last asked, in epoch milliseconds (also after a failed attempt). */
  checkedAt: number
  /** Latest version seen, if any attempt succeeded. */
  latest?: string
}

/** Arguments after which no check runs: the upgrade itself, version and help output, hooks. */
const SKIP_COMMANDS = new Set(["upgrade", "update", "__run-hook"])
const SKIP_FLAGS = new Set(["--version", "-V", "--help", "-h"])

/**
 * Whether a check should start for this invocation. It is skipped for `upgrade`/`update`,
 * `--version` and `--help`, when stdout is no terminal, when `CI` is set, and when
 * `ROSTOK_NO_UPDATE_CHECK=1`.
 */
export function shouldCheck(
  args: string[],
  env: (key: string) => string | undefined,
  stdoutIsTerminal: boolean,
): boolean {
  if (!stdoutIsTerminal) return false
  if (env("CI")) return false
  if (env("ROSTOK_NO_UPDATE_CHECK") === "1") return false
  if (args.length > 0 && SKIP_COMMANDS.has(args[0])) return false
  if (args.some((a) => SKIP_FLAGS.has(a))) return false
  return true
}

/** `$XDG_CACHE_HOME/rostok/update-check.json`, else `~/.cache/…`; undefined without a home. */
export function statePath(env: (key: string) => string | undefined): string | undefined {
  const cache = env("XDG_CACHE_HOME") || (env("HOME") ? join(env("HOME")!, ".cache") : undefined)
  return cache ? join(cache, NAME, "update-check.json") : undefined
}

/** Parses the state file; anything unexpected counts as no state. */
export function parseState(text: string): UpdateCheckState | undefined {
  try {
    const raw = JSON.parse(text)
    if (typeof raw?.checkedAt !== "number" || !Number.isFinite(raw.checkedAt)) return undefined
    const latest = typeof raw.latest === "string" ? normalizeVersion(raw.latest) : undefined
    return latest ? { checkedAt: raw.checkedAt, latest } : { checkedAt: raw.checkedAt }
  } catch {
    return undefined
  }
}

/**
 * Whether the network may be asked now. A `checkedAt` in the future (a clock set back) counts as
 * stale, so a wrong clock cannot silence the check for good.
 */
export function isDue(state: UpdateCheckState | undefined, now: number): boolean {
  if (!state) return true
  const age = now - state.checkedAt
  return age < 0 || age >= CHECK_INTERVAL_MS
}

/** The notice line, or undefined when `latest` is not newer than `current`. */
export function updateNotice(current: string, latest: string | undefined): string | undefined {
  if (!latest) return undefined
  try {
    if (compareVersions(latest, current) <= 0) return undefined
  } catch {
    return undefined
  }
  return `${NAME} ${latest} is available (you have ${current}). Run: ${NAME} upgrade`
}

/** What {@link checkForUpdate} touches outside its own logic, so tests can replace it. */
export interface UpdateCheckDeps {
  now: () => number
  currentVersion: string
  /** Path of the state file; undefined disables the check. */
  statePath: string | undefined
  /** Asks the network; may throw or return undefined. */
  fetchLatest: (signal: AbortSignal) => Promise<string | undefined>
  readText: (path: string) => Promise<string>
  writeText: (path: string, text: string) => Promise<void>
}

/**
 * Runs one check and resolves to the notice line, or undefined. Reads the state file; asks the
 * network only when the last attempt is 24 hours old, and records the attempt whatever its
 * result. Never rejects. `signal` cuts the request short, e.g. when the command has finished.
 */
export async function checkForUpdate(
  deps: UpdateCheckDeps,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const path = deps.statePath
    if (!path) return undefined
    const state = await deps.readText(path).then(parseState, () => undefined)
    const now = deps.now()
    if (!isDue(state, now)) return updateNotice(deps.currentVersion, state?.latest)

    // The attempt is recorded before the request, so a network that hangs (or a command that
    // ends first and cuts the request short) costs one short wait a day, not one every run.
    const save = (latest: string | undefined) =>
      deps.writeText(
        path,
        JSON.stringify(latest ? { checkedAt: now, latest } : { checkedAt: now }) + "\n",
      ).catch(() => {})
    await save(state?.latest)
    if (signal.aborted) return undefined
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    const latest = await deps.fetchLatest(AbortSignal.any([signal, timeout])).catch(() => undefined)
    if (latest) await save(latest)
    const seen = latest ?? state?.latest
    return updateNotice(deps.currentVersion, seen)
  } catch {
    return undefined
  }
}

/** The real dependencies of {@link checkForUpdate}. */
export function defaultUpdateCheckDeps(): UpdateCheckDeps {
  const env = (key: string) => Deno.env.get(key)
  const base = releasesUrl(env)
  return {
    now: Date.now,
    currentVersion: VERSION,
    statePath: statePath(env),
    fetchLatest: (signal) => fetchLatestVersion(base, { signal }),
    readText: (path) => Deno.readTextFile(path),
    writeText: async (path, text) => {
      await Deno.mkdir(join(path, ".."), { recursive: true })
      await Deno.writeTextFile(path, text)
    },
  }
}

/** A check running next to the command; {@link finish} prints its result. */
export interface BackgroundCheck {
  /** Waits up to `waitMs` for the check, prints the notice to stderr if any, stops the request. */
  finish: (waitMs?: number) => Promise<void>
}

/**
 * Starts a check in the background. The returned `finish` waits at most `waitMs` for it, so a
 * slow or dead network adds at most that to a command, and then aborts the request so the
 * process can exit at once.
 */
export function startUpdateCheck(
  deps: UpdateCheckDeps,
  print: (line: string) => void = (line) => console.error(line),
): BackgroundCheck {
  const controller = new AbortController()
  const result = checkForUpdate(deps, controller.signal)
  return {
    finish: async (waitMs = NOTICE_WAIT_MS) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), waitMs)
      })
      const notice = await Promise.race([result, timedOut])
      clearTimeout(timer)
      controller.abort()
      if (notice) print(notice)
    },
  }
}
