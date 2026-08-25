// Catalog path resolution + filesystem walker for the `--catalog=<dir>`
// override.
//
// The default catalog ships inside the CLI binary (see cli/catalog.ts).
// The CLI accepts `--catalog=<path>` for forks / custom stacks (v2
// territory); when set, `loadCatalogFromDir()` walks that directory
// for `+meta.ts` files.

import { join } from "@std/path"
import { type CatalogEntry, findStack } from "./catalog.ts"
import { validateStackMeta } from "./stack-meta.ts"

/**
 * Load a catalog from a filesystem directory. Used when the user passes
 * `--catalog=<path>` (v2 fork territory). Each immediate subdir is
 * scanned for `+meta.ts` and validated against the StackMeta schema.
 *
 * Throws if the directory doesn't exist; throws on validation failure.
 */
export async function loadCatalogFromDir(catalogDir: string): Promise<CatalogEntry[]> {
  let subdirs: string[]
  try {
    subdirs = []
    for await (const entry of Deno.readDir(catalogDir)) {
      if (entry.isDirectory) subdirs.push(entry.name)
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(`catalog directory not found: ${catalogDir}`)
    }
    throw err
  }
  subdirs.sort()

  const entries: CatalogEntry[] = []
  for (const name of subdirs) {
    const metaPath = join(catalogDir, name, "+meta.ts")
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
