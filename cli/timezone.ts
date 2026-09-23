// Server timezone detection (#212 smaller item).
//
// The old implementation read only `/etc/timezone` (Debian/Ubuntu) and
// detected the *local* machine's zone, not the server's. On Fedora or
// macOS (no `/etc/timezone`) it fell straight to `UTC`, even when the
// local shell's own zone — or the remote server's — was known.
//
// Detection order, first non-empty value wins:
//   1. `Intl.DateTimeFormat().resolvedOptions().timeZone` (local, always
//      available in Deno — no shell-out, works on every OS).
//   2. `/etc/timezone` (local file, Debian/Ubuntu).
//   3. `timedatectl show -p Timezone --value` over the SSH target the
//      wizard already probed (#207) — only attempted when that probe
//      reached the server, so a dead/unreachable target doesn't add a
//      second hanging SSH round trip.
//   4. `UTC`.
//
// Each source is injectable so tests can check the exact order without
// shelling out or touching the filesystem.

export interface TimezoneSources {
  /** Local `Intl` zone. Defaults to the real `Intl.DateTimeFormat`. */
  local?: () => string | undefined
  /** Local `/etc/timezone` contents. Defaults to a real file read. */
  etcTimezone?: () => Promise<string | undefined>
  /**
   * Remote `timedatectl` over the SSH target already probed for #207.
   * Defaults to a no-op (undefined) — callers pass a real implementation
   * only when they already know the target is reachable.
   */
  remote?: () => Promise<string | undefined>
}

/** Real local `Intl` zone — never throws; Deno always has *some* resolved zone. */
function defaultLocal(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

/** Real `/etc/timezone` read (Debian/Ubuntu). Missing file / any error → undefined. */
async function defaultEtcTimezone(): Promise<string | undefined> {
  try {
    const text = await Deno.readTextFile("/etc/timezone")
    return text.trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Detect a timezone default, trying each source in order and returning
 * the first non-empty value. Falls back to `"UTC"` when every source is
 * empty or missing.
 */
export async function detectTimezone(sources: TimezoneSources = {}): Promise<string> {
  const local = sources.local ?? defaultLocal
  const etcTimezone = sources.etcTimezone ?? defaultEtcTimezone
  const remote = sources.remote ?? (() => Promise.resolve(undefined))

  const fromLocal = local()
  if (fromLocal) return fromLocal

  const fromEtc = await etcTimezone()
  if (fromEtc) return fromEtc

  const fromRemote = await remote()
  if (fromRemote) return fromRemote

  return "UTC"
}

/**
 * Real remote source: `timedatectl show -p Timezone --value` over
 * `target`, with a short deadline so a slow/half-open connection can't
 * stall the wizard. Only meant to be called when the caller already
 * knows SSH reached the server (e.g. the #207 probe succeeded) — it does
 * not retry or report failures, it just returns `undefined` on any of
 * them so `detectTimezone` falls through to the next source.
 */
export async function remoteTimedatectlTimezone(
  target: string,
  opts: { deadlineMs?: number } = {},
): Promise<string | undefined> {
  const deadlineMs = opts.deadlineMs ?? 5_000
  let child: Deno.ChildProcess
  try {
    child = new Deno.Command("ssh", {
      args: [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "--",
        target,
        "timedatectl show -p Timezone --value",
      ],
      stdout: "piped",
      stderr: "null",
    }).spawn()
  } catch {
    return undefined
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      child.kill("SIGKILL")
    } catch {
      // already exited between the timer firing and the kill call.
    }
  }, deadlineMs)

  try {
    const out = await child.output()
    if (timedOut || !out.success) return undefined
    const text = new TextDecoder().decode(out.stdout).trim()
    return text || undefined
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
