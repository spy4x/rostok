// Tracks every child process deploy has spawned that might still be
// running when a SIGINT/SIGTERM signal handler needs to clean up
// (run-deploy.ts) — a hanging `ssh`/`rsync` call or a still-running
// hook. Without this, Ctrl-C during a hook or an ssh/rsync call removed
// the staging directory but left that child (and, for a hook, whatever
// IT spawned) running, reparented once the deploy process exits.
//
// killActiveChildren must be fully SYNCHRONOUS (no `await` anywhere in
// its call chain) — see run-deploy.ts's signal handler for why: an
// async cleanup routine yields the event loop between its own steps,
// which gives the main deploy flow's still-pending work a chance to
// keep running concurrently (observed: a ~1,500-file stack survived a
// signal 3 times out of 5, because the async `Deno.remove` was racing
// the main flow's own file writes into the same directory). A
// synchronous function runs to completion without yielding, so nothing
// else can interleave with it.

export interface TrackedChild {
  child: Deno.ChildProcess
  pid: number
  /**
   * True when this child was started under `setsid` as its own
   * process-group leader — its pid then doubles as its process-group
   * id, so `Deno.kill(-pid, sig)` reaches it AND every child it spawned
   * (a hook's own subprocess), not just the direct child.
   */
  isGroupLeader: boolean
}

const activeChildren = new Set<TrackedChild>()

let cachedGroupKillSupport: boolean | undefined

/**
 * Whether this Deno build's `Deno.kill` accepts a negative pid (a
 * process-group signal, per POSIX kill(2)) rather than rejecting it
 * outright. Detected once, cached: calls `Deno.kill` with a pid that
 * cannot realistically exist — if negative pids are rejected at the
 * API boundary, that throws synchronously (TypeError/RangeError)
 * before any OS call happens; if they're accepted and simply don't
 * match a real process-group, the OS-level "no such process" error
 * surfaces instead, proving the negative number reached the syscall.
 */
export function supportsProcessGroupKill(): boolean {
  if (cachedGroupKillSupport !== undefined) return cachedGroupKillSupport
  try {
    Deno.kill(-999_999_999, "SIGCONT")
    cachedGroupKillSupport = true
  } catch (err) {
    cachedGroupKillSupport = !(err instanceof TypeError || err instanceof RangeError)
  }
  return cachedGroupKillSupport
}

let cachedSetsidAvailable: Promise<boolean> | undefined

/** Whether a `setsid` binary is on PATH. Checked once, lazily, cached — used to give a hook its own process group. */
export function setsidAvailable(): Promise<boolean> {
  if (!cachedSetsidAvailable) {
    cachedSetsidAvailable = (async () => {
      try {
        const out = await new Deno.Command("setsid", {
          args: ["true"],
          stdout: "null",
          stderr: "null",
        }).output()
        return out.success
      } catch {
        return false
      }
    })()
  }
  return cachedSetsidAvailable
}

/**
 * Register `child` so `killActiveChildren` can reach it, and stop
 * tracking it once `child.status` settles. `isGroupLeader` marks a
 * child started under `setsid` (see `runHook` in hooks.ts).
 */
export function trackChild(child: Deno.ChildProcess, isGroupLeader = false): void {
  const entry: TrackedChild = { child, pid: child.pid, isGroupLeader }
  activeChildren.add(entry)
  child.status.finally(() => activeChildren.delete(entry))
}

function signalOne(entry: TrackedChild, signal: Deno.Signal): void {
  try {
    if (entry.isGroupLeader && supportsProcessGroupKill()) {
      Deno.kill(-entry.pid, signal)
    } else {
      entry.child.kill(signal)
    }
  } catch {
    // Already exited between the check and this call.
  }
}

/** Synchronous busy-wait — no timer/microtask, so nothing else can run during it. Bounded to a few hundred ms per call. */
function spinWaitMs(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) { /* spin */ }
}

/**
 * Terminate every tracked child: SIGTERM first, then a bounded
 * synchronous grace period, then SIGKILL unconditionally. Fully
 * synchronous end to end — see the module comment for why. A
 * group-leader child (spawned under `setsid` — see `hooks.ts`) gets
 * `-pid`, reaching its own children too; a child that ISN'T a group
 * leader (setsid unavailable, or this Deno build rejects a negative
 * pid) only gets the direct signal — see
 * docs/contributing/adding-services.md for why a hook must forward
 * termination to whatever it spawns in that case.
 *
 * SIGKILL is unconditional, not gated on an "is it still alive?"
 * check: signalling an already-exited pid just fails harmlessly
 * (caught in `signalOne`), so no liveness probe is needed here.
 */
export function killActiveChildren(): void {
  const snapshot = [...activeChildren]
  if (snapshot.length === 0) return

  for (const entry of snapshot) signalOne(entry, "SIGTERM")
  spinWaitMs(300)
  for (const entry of snapshot) signalOne(entry, "SIGKILL")
}
