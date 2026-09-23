// Tracks every child process deploy has spawned that might still be
// running when a SIGINT/SIGTERM signal handler needs to clean up
// (run-deploy.ts) — a hanging `ssh` call or a still-running hook. Without
// this, Ctrl-C during a hook or an ssh/rsync call removed the staging
// directory but left that child running, reparented once the deploy
// process exits.

const activeChildren = new Set<Deno.ChildProcess>()

/** Register `child` so `killActiveChildren` can reach it, and stop tracking it once `child.status` settles. */
export function trackChild(child: Deno.ChildProcess): void {
  activeChildren.add(child)
  child.status.finally(() => activeChildren.delete(child))
}

/** Send `signal` (default SIGKILL) to every still-tracked child. Never throws — a child that already exited is skipped. */
export function killActiveChildren(signal: Deno.Signal = "SIGKILL"): void {
  for (const child of activeChildren) {
    try {
      child.kill(signal)
    } catch {
      // Already exited between the signal firing and this loop running.
    }
  }
}
