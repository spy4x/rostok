// `rostok stack list` — browse the bundled catalog.
//
// Subcommands of `rostok stack`, alongside `rostok stack add`. Reads
// every stack's `+meta.ts` via cli/catalog.ts and prints them.
//
//   rostok stack list                       # table grouped by category
//   rostok stack list --format json         # machine-readable
//   rostok stack list --tree                # indented category tree
//
// The `--tree` mode groups by category. v1 has no `depends` field in
// StackMeta, so there's no real cross-stack deps graph (that's a v2
// feature per docs/v1-cli.md §11). For now `--tree` is a nicer
// presentation of the same data — proxy stacks at the top, then
// auth, monitoring, etc. — indented under their category header.

import { Command } from "@cliffy/command"
import { type CatalogEntry, loadCatalog } from "../catalog.ts"
import { DEFAULT_CATALOG_DIR, defaultCatalogDir } from "../catalog-paths.ts"

/**
 * Format a CatalogEntry as one row of the table view.
 *
 * Example: `traefik          Reverse proxy with auto-TLS via Let's Encrypt (5 vars)`
 */
export function formatTableRow(entry: CatalogEntry, width: number): string {
  const required = entry.meta.variables.filter((v) => v.required).length
  const total = entry.meta.variables.length
  const varLabel = total === 1 ? "var" : "vars"
  const reqLabel = required === total ? "" : ` (${required} required)`
  const desc = entry.meta.description
  return `  ${entry.meta.name.padEnd(width)} ${desc}${varCountSuffix(total, varLabel, reqLabel)}`
}

function varCountSuffix(total: number, varLabel: string, reqLabel: string): string {
  if (total === 0) return ""
  return `  [${total} ${varLabel}${reqLabel}]`
}

/** Group entries by category. Stacks without a category land in "other". */
export function groupByCategory(
  entries: CatalogEntry[],
): Map<string, CatalogEntry[]> {
  const groups = new Map<string, CatalogEntry[]>()
  for (const e of entries) {
    const cat = e.meta.category ?? "other"
    const list = groups.get(cat) ?? []
    list.push(e)
    groups.set(cat, list)
  }
  // Sort entries within each category.
  for (const list of groups.values()) list.sort((a, b) => a.meta.name.localeCompare(b.meta.name))
  return groups
}

/**
 * Render the catalog as a human-readable table grouped by category.
 * Category order: proxy first (foundational), then alphabetical.
 */
export function formatCatalogTable(entries: CatalogEntry[]): string {
  if (entries.length === 0) return "  (catalog empty)"
  const groups = groupByCategory(entries)
  const width = Math.max(...entries.map((e) => e.meta.name.length)) + 2
  const orderedCats = orderCategories([...groups.keys()])
  const lines: string[] = []
  for (const cat of orderedCats) {
    const list = groups.get(cat) ?? []
    lines.push(`${cat}/`)
    for (const e of list) lines.push(formatTableRow(e, width))
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

/** Stable category order: proxy first, then alphabetical. */
export function orderCategories(categories: string[]): string[] {
  const PROXY_FIRST = ["proxy"]
  const ordered: string[] = []
  for (const p of PROXY_FIRST) {
    if (categories.includes(p)) ordered.push(p)
  }
  const rest = categories.filter((c) => !PROXY_FIRST.includes(c)).sort()
  return [...ordered, ...rest]
}

/**
 * Render the catalog as an indented tree grouped by category. Each
 * category is a section header; stacks are indented under it.
 */
export function formatCatalogTree(entries: CatalogEntry[]): string {
  if (entries.length === 0) return "  (catalog empty)"
  const groups = groupByCategory(entries)
  const orderedCats = orderCategories([...groups.keys()])
  const lines: string[] = []
  for (const cat of orderedCats) {
    const list = groups.get(cat) ?? []
    lines.push(`${cat}/`)
    for (const e of list) {
      lines.push(`  └─ ${e.meta.name}: ${e.meta.description}`)
    }
    lines.push("")
  }
  return lines.join("\n").trimEnd()
}

/**
 * Minimal JSON-shaped view of a stack — what users scripting against
 * the catalog need. Drops internal fields (file paths, raw defaults).
 */
export interface JsonStackView {
  name: string
  description: string
  category: string | undefined
  variables: { key: string; required: boolean; secret: boolean }[]
}

export function toJsonStack(entry: CatalogEntry): JsonStackView {
  return {
    name: entry.meta.name,
    description: entry.meta.description,
    category: entry.meta.category,
    variables: entry.meta.variables.map((v) => ({
      key: v.key,
      required: v.required ?? true,
      secret: v.secret ?? false,
    })),
  }
}

export function formatCatalogJson(entries: CatalogEntry[]): string {
  return JSON.stringify(entries.map(toJsonStack), null, 2) + "\n"
}

/** `rostok stack list` — the subcommand. */
export const stackListCommand = new Command()
  .description("Browse the bundled catalog.")
  .option("--catalog <dir:string>", "override bundled catalog directory")
  .option("--format <fmt:string>", "table | json (default: table)")
  .option("--tree", "indented category tree")
  .action(async (options) => {
    const catalogDir = options.catalog ?? DEFAULT_CATALOG_DIR ?? defaultCatalogDir(Deno.cwd())
    const entries = await loadCatalog(catalogDir)
    const format = options.format ?? "table"
    if (format === "json") {
      console.log(formatCatalogJson(entries))
    } else if (options.tree) {
      console.log(formatCatalogTree(entries))
    } else if (format === "table") {
      console.log(formatCatalogTable(entries))
    } else {
      console.error(`rostok stack list: unknown --format '${format}'. use 'table' or 'json'.`)
      Deno.exit(1)
    }
  })
