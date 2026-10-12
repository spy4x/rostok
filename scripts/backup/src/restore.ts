import { basename, dirname } from "@std/path"

/** One folder of a snapshot and the place the backup config names for it. */
export interface RestoreMatch {
  snapshotPath: string
  to: string
}

/** One folder a restore puts back: where restic unpacked it, and where it belongs. */
export interface RestoreMove {
  from: string
  to: string
}

/**
 * Pairs each folder the backup config names with the snapshot folder that
 * holds its data: the same path when the snapshot has it.
 *
 * A snapshot taken before the data moved carries the old path. Such a folder
 * is matched by its last path segment, when exactly one unclaimed snapshot
 * path ends in it. Anything less certain throws, before a file is touched.
 */
export function planRestore(sourcePaths: string[], snapshotPaths: string[]): RestoreMatch[] {
  const exact = new Set(sourcePaths.filter((path) => snapshotPaths.includes(path)))
  const claimed = new Set(exact)
  return sourcePaths.map((to) => {
    if (exact.has(to)) return { snapshotPath: to, to }
    const candidates = snapshotPaths.filter((path) =>
      !claimed.has(path) && basename(path) === basename(to)
    )
    if (candidates.length !== 1) {
      throw new Error(
        `Cannot tell which folder of the snapshot belongs at ${to}. ` +
          `The snapshot holds: ${snapshotPaths.join(", ") || "nothing"}.`,
      )
    }
    claimed.add(candidates[0])
    return { snapshotPath: candidates[0], to }
  })
}

/**
 * Turns a snapshot path into a `restic restore --include` pattern that matches
 * only that path. restic reads `*`, `?` and `[` in a pattern as wildcards and
 * `\` as the escape character, so a folder named `data[1]` would otherwise
 * match `data1` and never itself.
 */
export function literalIncludePattern(snapshotPath: string): string {
  return snapshotPath.replace(/[\\*?[]/g, "\\$&")
}

/**
 * Puts the restored folders in place. Data already at a destination is
 * renamed to `<destination>.backup-<stamp>` and never deleted. Each restored
 * folder is renamed into place, not copied, so it keeps the owner and mode
 * restic gave it; `from` must therefore be on the destination's filesystem.
 *
 * When one folder cannot be put in place, every folder already swapped goes
 * back as it was, so the service never starts on half of a snapshot.
 * Returns the paths the old data was renamed to.
 */
export async function applyRestore(moves: RestoreMove[], stamp: string): Promise<string[]> {
  for (const { from } of moves) {
    if (!await exists(from)) {
      throw new Error(`The snapshot did not restore ${from}; nothing was changed.`)
    }
  }
  const done: Array<RestoreMove & { kept?: string }> = []
  try {
    for (const { from, to } of moves) {
      await Deno.mkdir(dirname(to), { recursive: true })
      const step: RestoreMove & { kept?: string } = { from, to }
      if (await exists(to)) {
        step.kept = `${to}.backup-${stamp}`
        await Deno.rename(to, step.kept)
      }
      done.push(step)
      await Deno.rename(from, to)
    }
  } catch (err) {
    const stuck: string[] = []
    for (const { from, to, kept } of done.reverse()) {
      try {
        // The last step may have failed before its restored folder moved.
        if (!await exists(from)) await Deno.rename(to, from)
        if (kept) await Deno.rename(kept, to)
      } catch {
        stuck.push(kept ? `${to} (its previous data is at ${kept})` : to)
      }
    }
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Could not put the restored data in place: ${reason}. ` +
        (stuck.length === 0
          ? "Every folder is back as it was before the restore."
          : `Could not put back: ${stuck.join(", ")}.`),
    )
  }
  return done.flatMap(({ kept }) => kept ? [kept] : [])
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path)
    return true
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false
    throw err
  }
}
