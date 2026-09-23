// Catalog path resolution + filesystem walker for the `--catalog=<dir>`
// override.
//
// The default catalog ships inside the CLI binary (see cli/catalog.ts).
// The CLI accepts `--catalog=<path>` for forks / custom stacks (v2
// territory); when set, `loadCatalogFromDir()` walks that directory
// for `+meta.ts` files.

import { join, resolve } from "@std/path"
import { type CatalogEntry, findStack } from "./catalog.ts"
import { validateStackMeta } from "./stack-meta.ts"
import { UserError } from "./errors.ts"

/**
 * Load a catalog from a filesystem directory. Used when the user passes
 * `--catalog=<path>` (v2 fork territory). Each immediate subdir is
 * scanned for `+meta.ts` and validated against the StackMeta schema.
 *
 * `+meta.ts` files are executed as code (dynamic `import`) — per #208,
 * `--catalog` must resolve to a directory the user trusts.
 *
 * `catalogDir` is resolved against `Deno.cwd()` first: a relative path
 * (e.g. `--catalog ./my-stacks`) fed straight into a `file://` URL
 * produces a malformed URL (the first path segment is parsed as the
 * URL's host, not part of the path), so every check and the dynamic
 * `import()` below need the absolute form.
 *
 * Throws a UserError if the directory doesn't exist, isn't readable, or
 * isn't a directory; throws on validation failure.
 */
export async function loadCatalogFromDir(catalogDir: string): Promise<CatalogEntry[]> {
  const dir = resolve(catalogDir)
  let stat: Deno.FileInfo
  try {
    stat = await Deno.stat(dir)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new UserError(`--catalog directory not found: ${dir}`)
    }
    if (err instanceof Deno.errors.PermissionDenied) {
      throw new UserError(`--catalog directory not readable (permission denied): ${dir}`)
    }
    throw new UserError(
      `can't read --catalog directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!stat.isDirectory) {
    throw new UserError(`--catalog must be a directory: ${dir}`)
  }

  const subdirs: string[] = []
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) subdirs.push(entry.name)
  }
  subdirs.sort()

  const entries: CatalogEntry[] = []
  for (const name of subdirs) {
    const metaPath = join(dir, name, "+meta.ts")
    try {
      await Deno.stat(metaPath)
    } catch {
      continue // dir without +meta.ts — skip silently
    }
    const mod = await import(pathToFileUrl(metaPath))
    const meta = validateStackMeta(mod.default)
    entries.push({ name, meta })
  }
  return entries
}

/** Convenience: prefer the bundled catalog, fall back to a directory if given. */
export async function resolveCatalog(
  catalogDir: string | undefined,
): Promise<CatalogEntry[]> {
  if (catalogDir) return await loadCatalogFromDir(catalogDir)
  // Lazy import to avoid circular deps — loadCatalog pulls in all stacks.
  const { loadCatalog } = await import("./catalog.ts")
  return loadCatalog()
}

/** Convert an absolute path to a `file://` URL for dynamic import. */
function pathToFileUrl(path: string): string {
  return new URL(`file://${path.replace(/\\/g, "/")}`).href
}

// Re-export for legacy callers.
export { findStack }
