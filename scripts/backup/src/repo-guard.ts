/**
 * Subdirectories whose presence in a path means restic has previously
 * initialised or used a repository at that location.
 *
 * Kept as a module-level constant so tests can import the same
 * definition as production code (no duplicated allow-list that could
 * drift).
 */
export const RESTIC_REPO_SUBDIRS = ["keys", "data", "index", "snapshots"] as const

/**
 * Returns true when `repoPath` is a directory that already contains any
 * non-empty restic subdirectory (`keys/`, `data/`, `index/`,
 * `snapshots/`).
 *
 * Used to refuse a silent re-init: if restic reports "not a repository"
 * for a path that still holds restic artefacts from an earlier
 * incarnation, the orphan key (or index, etc.) would coexist with a
 * freshly-written `config` and the resulting repo would be unreadable.
 * Detected by the offline-backup restic check as
 * "Fatal: config or key <id> is damaged: ciphertext verification
 * failed" (restic does not try the remaining keys once one config-auth
 * check fails).
 *
 * A non-existent or empty path returns false so the normal init flow
 * proceeds. A subdirectory that exists but cannot be listed returns
 * true: it cannot be proved empty, and refusing init is safer than
 * letting the listing error abort the run.
 *
 * Pure with respect to its inputs (only reads the FS via the injected
 * `stat`/`readDir`) so it can be tested without restic and without
 * booting the full backup module (which loads env vars at init time).
 */
export async function hasNonEmptyResticSubdir(
  repoPath: string,
  statFn: (path: string) => Promise<Deno.FileInfo | null> = (p) => Deno.stat(p).catch(() => null),
  readDirFn: (path: string) => AsyncIterable<Deno.DirEntry> = (p) => Deno.readDir(p),
): Promise<boolean> {
  const stat = await statFn(repoPath)
  if (!stat || !stat.isDirectory) {
    return false
  }
  for (const sub of RESTIC_REPO_SUBDIRS) {
    const subStat = await statFn(`${repoPath}/${sub}`)
    if (subStat && subStat.isDirectory) {
      let hasEntry = false
      try {
        // One entry is enough — an empty subdirectory isn't a real restic
        // artefact. ReadDir iterates lazily; we break on the first hit.
        for await (const _ of readDirFn(`${repoPath}/${sub}`)) {
          hasEntry = true
          break
        }
      } catch {
        // The directory exists but cannot be listed (permissions, I/O).
        // Treat it as occupied: refusing init and pointing the operator
        // at the recovery flow is safer than letting the error escape
        // and abort the whole backup run with a stack trace.
        hasEntry = true
      }
      if (hasEntry) {
        return true
      }
    }
  }
  return false
}
