import { basename, dirname, join } from "@std/path"

/** One folder a restore puts back: where restic wrote it, and where it belongs. */
export interface RestoreMove {
  from: string
  to: string
}

/**
 * Pairs each folder the backup config names with its copy under `restoreRoot`.
 * `restic restore --target <root>` rebuilds every snapshot path below the
 * root with its full original path, so `/srv/volumes/app` lands at
 * `<root>/srv/volumes/app`.
 *
 * A snapshot taken before the data moved carries the old path. Such a folder
 * is matched by its last path segment, when exactly one unclaimed snapshot
 * path ends in it. Anything less certain throws, before a file is touched.
 */
export function planRestore(
  sourcePaths: string[],
  snapshotPaths: string[],
  restoreRoot: string,
): RestoreMove[] {
  const exact = new Set(sourcePaths.filter((path) => snapshotPaths.includes(path)))
  const claimed = new Set(exact)
  return sourcePaths.map((to) => {
    if (exact.has(to)) return { from: join(restoreRoot, to), to }
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
    return { from: join(restoreRoot, candidates[0]), to }
  })
}

/**
 * Puts the restored folders in place. Data already at a destination is
 * renamed to `<destination>.backup-<stamp>` and never deleted. The restored
 * folder is moved, not copied, so it keeps the owner and mode restic gave it.
 * Returns the paths the old data was renamed to.
 */
export async function applyRestore(moves: RestoreMove[], stamp: string): Promise<string[]> {
  for (const { from } of moves) {
    if (!await exists(from)) {
      throw new Error(`The snapshot did not restore ${from}; nothing was changed.`)
    }
  }
  const keptOldData: string[] = []
  for (const { from, to } of moves) {
    await Deno.mkdir(dirname(to), { recursive: true })
    let kept: string | undefined
    if (await exists(to)) {
      kept = `${to}.backup-${stamp}`
      await Deno.rename(to, kept)
      keptOldData.push(kept)
    }
    const { success, stderr } = await new Deno.Command("mv", {
      args: [from, to],
      stdout: "null",
      stderr: "piped",
    }).output()
    if (!success) {
      throw new Error(
        `Could not move the restored data to ${to}: ${new TextDecoder().decode(stderr).trim()}` +
          (kept ? ` The data that was there is kept at ${kept}.` : ""),
      )
    }
  }
  return keptOldData
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
