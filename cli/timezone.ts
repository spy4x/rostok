// Server timezone detection (#212 smaller item).
//
// The old implementation read only `/etc/timezone` (Debian/Ubuntu) and
// detected the *local* machine's zone, not the server's. On Fedora or
// macOS (no `/etc/timezone`) it fell straight to `UTC`, even when the
// local shell's own zone — or the remote server's — was known.
//
// TIMEZONE configures containers *on the server*, so the server's own
// zone wins whenever it's knowable. Detection order, first valid,
// non-empty value wins:
//   1. `timedatectl show -p Timezone --value` over the SSH target the
//      wizard already probed (#207) — only attempted when that probe
//      reached the server, so a dead/unreachable target doesn't add a
//      second hanging SSH round trip.
//   2. `Intl.DateTimeFormat().resolvedOptions().timeZone` (local, always
//      available in Deno — no shell-out, works on every OS).
//   3. `/etc/timezone` (local file, Debian/Ubuntu).
//   4. `UTC`.
//
// Every candidate — remote or local — is validated as a real IANA zone
// name before it's accepted: an empty answer, a truncated `timedatectl`
// line, or garbage from a misbehaving shell profile on the remote end
// must fall through to the next source, not become TIMEZONE's value.
//
// Each source is injectable so tests can check the exact order without
// shelling out or touching the filesystem.

import { parseSshAddress, sshArgs } from "./server-keys.ts"

export interface TimezoneSources {
  /**
   * Remote `timedatectl` over the SSH target already probed for #207.
   * Defaults to a no-op (undefined) — callers pass a real implementation
   * only when they already know the target is reachable.
   */
  remote?: () => Promise<string | undefined>
  /** Local `Intl` zone. Defaults to the real `Intl.DateTimeFormat`. */
  local?: () => string | undefined
  /** Local `/etc/timezone` contents. Defaults to a real file read. */
  etcTimezone?: () => Promise<string | undefined>
}

/**
 * True when `Intl.DateTimeFormat` accepts `tz` as a timeZone — the
 * standard way to validate an IANA name without a lookup table.
 *
 * Review nit — canonicalizing a legacy alias (`Asia/Saigon` →
 * `Asia/Ho_Chi_Minh`) was considered, but neither
 * `Intl.DateTimeFormat(undefined, { timeZone }).resolvedOptions().timeZone`
 * nor `Temporal.Now.zonedDateTimeISO(tz).timeZoneId` canonicalize it in
 * this runtime's ICU — both echo the alias back unchanged, and
 * `Intl.supportedValuesOf("timeZone")` lists `Asia/Saigon` but not
 * `Asia/Ho_Chi_Minh`, so there's no reliable JS-exposed canonicalization
 * to call here. Skipped; the alias is still a valid IANA name and works
 * correctly wherever TIMEZONE is used.
 */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Accept `candidate` only when it's non-empty (after trimming) and a valid IANA zone name; otherwise treat the source as unavailable. */
function validCandidate(candidate: string | undefined): string | undefined {
  if (candidate === undefined) return undefined
  const trimmed = candidate.trim()
  if (!trimmed || !isValidTimezone(trimmed)) return undefined
  return trimmed
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
 * Detect a timezone default, trying each source in order — remote
 * server first, since TIMEZONE configures containers running there —
 * and returning the first valid, non-empty value. Falls back to
 * `"UTC"` when every source is empty, invalid, or missing.
 */
export async function detectTimezone(sources: TimezoneSources = {}): Promise<string> {
  const remote = sources.remote ?? (() => Promise.resolve(undefined))
  const local = sources.local ?? defaultLocal
  const etcTimezone = sources.etcTimezone ?? defaultEtcTimezone

  const fromRemote = validCandidate(await remote())
  if (fromRemote) return fromRemote

  const fromLocal = validCandidate(local())
  if (fromLocal) return fromLocal

  const fromEtc = validCandidate(await etcTimezone())
  if (fromEtc) return fromEtc

  return "UTC"
}

/**
 * Real remote source: `timedatectl show -p Timezone --value` over
 * `target`, with a short deadline so a slow/half-open connection can't
 * stall the wizard. Only meant to be called when the caller already
 * knows SSH reached the server (e.g. the #207 probe succeeded) — it does
 * not retry or report failures, it just returns `undefined` on any of
 * them so `detectTimezone` falls through to the next source. The raw
 * output isn't validated here — `detectTimezone`'s `validCandidate`
 * does that for every source uniformly.
 */
export async function remoteTimedatectlTimezone(
  target: string,
  opts: { deadlineMs?: number } = {},
): Promise<string | undefined> {
  const deadlineMs = opts.deadlineMs ?? 5_000
  let child: Deno.ChildProcess
  try {
    // #218: same argv-building as server-create.ts's probeServer — a
    // ported SSH_ADDRESS (`root@192.0.2.1:2222`) must reach ssh as
    // `-p 2222 root@192.0.2.1`, not one unresolvable hostname string.
    const sshTarget = parseSshAddress(target)
    const args = [
      "-o",
      "StrictHostKeyChecking=accept-new",
      ...sshArgs(sshTarget, ["timedatectl show -p Timezone --value"], { batchMode: true }),
    ]
    child = new Deno.Command("ssh", {
      args,
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
