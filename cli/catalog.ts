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
import { UserError } from "./errors.ts"

export interface CatalogEntry {
  meta: StackMeta
  /** Stack directory name (e.g. "traefik"). Used for display + sorting. */
  name: string
}

/**
 * Thrown by `findStack` when `name` matches nothing in the catalog —
 * never for an ambiguous match (`UserError` directly, see below). #236:
 * `stack-remove.ts`'s `tryFindStack` used to tell "not found" and
 * "ambiguous" apart by matching the thrown UserError's message text
 * (`.includes("not found in catalog")`), so rewording that message would
 * have silently changed which case is treated as "gone from the
 * catalog" vs. re-thrown as a real error. A dedicated class makes that
 * distinction independent of wording.
 */
export class StackNotFoundError extends UserError {}

// Static imports — bundled into the CLI binary via JSR's resolver.
import traefik from "../stacks/traefik/+meta.ts"
import gatus from "../stacks/gatus/+meta.ts"
import vaultwarden from "../stacks/vaultwarden/+meta.ts"
import jellyfin from "../stacks/jellyfin/+meta.ts"
import filebrowser from "../stacks/filebrowser/+meta.ts"
import librespeed from "../stacks/librespeed/+meta.ts"
import deepseekHarness from "../stacks/deepseek-harness/+meta.ts"
import watchtower from "../stacks/watchtower/+meta.ts"
import syncthing from "../stacks/syncthing/+meta.ts"
import homeAssistant from "../stacks/home-assistant/+meta.ts"
import wireguard from "../stacks/wireguard/+meta.ts"
import ntfy from "../stacks/ntfy/+meta.ts"
import oko from "../stacks/oko/+meta.ts"
import immich from "../stacks/immich/+meta.ts"
import piped from "../stacks/piped/+meta.ts"
import transmission from "../stacks/transmission/+meta.ts"
import playwright from "../stacks/playwright/+meta.ts"
import searxng from "../stacks/searxng/+meta.ts"
import openWebui from "../stacks/open-webui/+meta.ts"
import audiobookshelf from "../stacks/audiobookshelf/+meta.ts"
import metube from "../stacks/metube/+meta.ts"
import woodpecker from "../stacks/woodpecker/+meta.ts"
import usememos from "../stacks/usememos/+meta.ts"
import victoriaMetrics from "../stacks/victoria-metrics/+meta.ts"
import akaunting from "../stacks/akaunting/+meta.ts"
import gitea from "../stacks/gitea/+meta.ts"
import traggo from "../stacks/traggo/+meta.ts"
import dockerRegistry from "../stacks/docker-registry/+meta.ts"
import dockerSockProxy from "../stacks/docker-sock-proxy/+meta.ts"
import caldavMcp from "../stacks/caldav-mcp/+meta.ts"
import emailMcp from "../stacks/email-mcp/+meta.ts"
import googleMapsMcp from "../stacks/google-maps-mcp/+meta.ts"
import githubMcp from "../stacks/github-mcp/+meta.ts"
import zond from "../stacks/zond/+meta.ts"
import omniTools from "../stacks/omni-tools/+meta.ts"

// Stacks without a +meta.ts are not in the catalog yet; issue #283 adds the rest.

const STACK_META: Record<string, StackMeta> = {
  traefik,
  gatus,
  vaultwarden,
  jellyfin,
  filebrowser,
  librespeed,
  "deepseek-harness": deepseekHarness,
  watchtower,
  syncthing,
  "home-assistant": homeAssistant,
  wireguard,
  ntfy,
  oko,
  immich,
  piped,
  transmission,
  playwright,
  searxng,
  "open-webui": openWebui,
  audiobookshelf,
  metube,
  woodpecker,
  usememos,
  "victoria-metrics": victoriaMetrics,
  akaunting,
  gitea,
  traggo,
  "docker-registry": dockerRegistry,
  "docker-sock-proxy": dockerSockProxy,
  "caldav-mcp": caldavMcp,
  "email-mcp": emailMcp,
  "google-maps-mcp": googleMapsMcp,
  "github-mcp": githubMcp,
  zond,
  "omni-tools": omniTools,
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
    throw new StackNotFoundError(
      `stack '${name}' not found in catalog. available: ${available || "(none)"}`,
    )
  }
  if (matches.length > 1) {
    throw new UserError(`ambiguous stack name '${name}': ${matches.length} entries`)
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
