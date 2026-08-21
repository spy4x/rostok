// Catalog loader.
//
// Discovers `+meta.ts` files under a stacks directory, dynamically imports
// each one, validates with `validateStackMeta`, and returns the resulting
// `StackMeta[]`.
//
// In dev mode the catalog lives at `./stacks/` (the rostok repo root). In
// the published JSR package it will be bundled at publish time — Phase 10.
//
// Phase 5 ships the dynamic-import path. Bundling is Phase 10.

import { join, relative } from "@std/path"
import { validateStackMeta } from "./stack-meta.ts"
import type { StackMeta } from "./stack-meta.ts"

export interface CatalogEntry {
  meta: StackMeta
  /** Absolute path to the stack's directory (where compose.yml lives). */
  dir: string
}

/**
 * Scan `catalogDir` for `+meta.ts` files one level deep.
 *
 *   catalogDir/
 *     traefik/+meta.ts
 *     gatus/+meta.ts
 *     ...
 *
 * Returns entries sorted by stack name. Throws if any +meta.ts fails
 * validation — better to fail loud at startup than to silently corrupt
 * the user's project.
 */
export async function loadCatalog(catalogDir: string): Promise<CatalogEntry[]> {
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
    const dir = join(catalogDir, name)
    const metaPath = join(dir, "+meta.ts")
    try {
      await Deno.stat(metaPath)
    } catch {
      // Directory has no +meta.ts — skip silently (could be a non-stack dir).
      continue
    }
    const mod = await import(/* @vite-ignore */ pathToFileUrl(metaPath))
    const meta = validateStackMeta(mod.default)
    entries.push({ meta, dir })
  }
  return entries
}

/**
 * Resolve a stack name in the catalog. Throws on missing or ambiguous
 * (no duplicates in v1, but guard for future cross-stack imports).
 */
export function findStack(
  catalog: CatalogEntry[],
  name: string,
): CatalogEntry {
  const matches = catalog.filter((e) => e.meta.name === name)
  if (matches.length === 0) {
    const available = catalog.map((e) => e.meta.name).join(", ")
    throw new Error(`stack '${name}' not found in catalog. available: ${available || "(none)"}`)
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous stack name '${name}': ${matches.length} entries`)
  }
  return matches[0]
}

/** Format catalog for the `stack list` subcommand (Phase 6 — placeholder). */
export function formatCatalogSummary(entries: CatalogEntry[]): string {
  const lines: string[] = []
  for (const e of entries) {
    const rel = relative(Deno.cwd(), e.dir)
    lines.push(`  ${e.meta.name.padEnd(16)} ${e.meta.description} (${rel})`)
  }
  return lines.join("\n")
}

/** Convert an absolute path to a `file://` URL for dynamic import. */
function pathToFileUrl(path: string): string {
  // Deno-native path → URL conversion. Avoids a `pathToFileURL` import.
  // Normalize Windows paths (not relevant on Deno-only repo but defensive).
  return new URL(`file://${path.replace(/\\/g, "/")}`).href
}
