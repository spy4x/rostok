// Shared catalog-path resolution.
//
// Two places in the CLI need to find the bundled catalog:
//   - `cli/wizard.ts` and `cli/stack-add.ts` (resolve stacks for runtime use)
//   - `cli/commands/list.ts` (browse + JSON output)
//
// Each historically had its own `defaultCatalogDir` walker. Phase 6
// consolidates them here. Dev assumption: rostok CLI runs from `cli/`
// and the catalog lives at `<repo>/stacks/`. Bundling into the JSR
// binary is Phase 10.

import { join } from "@std/path"

/**
 * Walk up to 5 levels looking for a `stacks/` directory. Returns the
 * absolute path to that directory, or throws if not found.
 *
 * In dev mode the rostok repo is checked out adjacent to the CLI; in
 * the published JSR package (Phase 10) the catalog will be bundled and
 * this helper will resolve to the embedded resource instead.
 */
export function defaultCatalogDir(cwd: string): string {
  let dir = cwd
  for (let i = 0; i < 5; i++) {
    try {
      const stat = Deno.statSync(join(dir, "stacks"))
      if (stat.isDirectory) return join(dir, "stacks")
    } catch {
      // not found, walk up
    }
    const parent = join(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    `could not locate bundled catalog (no stacks/ found within 5 levels of ${cwd}). ` +
      `pass --catalog=<path> to override.`,
  )
}

/**
 * The default catalog directory at module load time. Cached because
 * the CLI is invoked once per process; re-resolving on every command
 * would re-stat 5 paths for no benefit.
 *
 * `undefined` if cwd lacks `stacks/` within 5 levels — `loadCatalog`
 * callers pass an explicit dir in that case.
 */
export const DEFAULT_CATALOG_DIR: string | undefined = (() => {
  try {
    return defaultCatalogDir(Deno.cwd())
  } catch {
    return undefined
  }
})()
