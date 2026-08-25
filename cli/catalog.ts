// Catalog loader.
//
// The catalog ships inside the CLI binary via static imports. JSR's
// bundler resolves each `+meta.ts` at publish time and includes the
// files in the published package — `rostok` works without a `--catalog`
// flag from any project folder.
//
// Adding a stack:
//   1. Create `stacks/<name>/+meta.ts` with a `StackMeta` default export.
//   2. Add a static import + entry below.
//
// `--catalog=<dir>` (handled in `catalog-paths.ts`) remains available for
// forks / custom stacks — v2 territory per docs/v2-cli.md.

import type { StackMeta } from "./stack-meta.ts"

export interface CatalogEntry {
  meta: StackMeta
  /** Stack directory name (e.g. "traefik"). Used for display + sorting. */
  name: string
}

// Static imports — bundled into the CLI binary via JSR's resolver.
import traefik from "../stacks/traefik/+meta.ts"
import gatus from "../stacks/gatus/+meta.ts"
import vaultwarden from "../stacks/vaultwarden/+meta.ts"
import jellyfin from "../stacks/jellyfin/+meta.ts"
import filebrowser from "../stacks/filebrowser/+meta.ts"
import librespeed from "../stacks/librespeed/+meta.ts"

// A second batch is already shipping in stacks/ but their +meta.ts isn't
// written yet — Phase 4 shipped the first 6. The remaining ~40 stacks
// will add +meta.ts + an entry here in follow-up PRs. Until then the
// catalog only contains the 6 first-batch stacks.

const STACK_META: Record<string, StackMeta> = {
  traefik,
  gatus,
  vaultwarden,
  jellyfin,
  filebrowser,
  librespeed,
}

const ENTRIES: CatalogEntry[] = Object.entries(STACK_META)
  .map(([name, meta]) => ({ name, meta }))
  .sort((a, b) => a.name.localeCompare(b.name))

/**
 * Return the bundled catalog entries. Pure (no I/O) — the catalog is
 * embedded in the binary, so this is a constant array.
 */
export function loadCatalog(): CatalogEntry[] {
  return ENTRIES
}

/**
 * Resolve a stack by name. Matches the entry's import-key (which is
 * always the directory name) and falls back to `meta.name` for stacks
 * whose +meta.ts declares a different display name.
 */
export function findStack(
  catalog: CatalogEntry[],
  name: string,
): CatalogEntry {
  const matches = catalog.filter((e) => e.name === name || e.meta.name === name)
  if (matches.length === 0) {
    const available = catalog.map((e) => e.name).join(", ")
    throw new Error(`stack '${name}' not found in catalog. available: ${available || "(none)"}`)
  }
  if (matches.length > 1) {
    throw new Error(`ambiguous stack name '${name}': ${matches.length} entries`)
  }
  return matches[0]
}

/**
 * Format a one-line summary of the catalog. Kept for parity with the
 * pre-bundling implementation — currently unused by the CLI surface
 * but still useful for debugging.
 */
export function formatCatalogSummary(entries: CatalogEntry[]): string {
  const lines: string[] = []
  for (const e of entries) {
    lines.push(`  ${e.name.padEnd(16)} ${e.meta.description}`)
  }
  return lines.join("\n")
}
