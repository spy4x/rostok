// Tests for cli/commands/list.ts — catalog formatters.
//
// These tests construct synthetic CatalogEntry objects so they don't
// depend on the bundled catalog (which lives at <repo>/stacks/ and
// would make the tests order-dependent on disk layout).

import { assertEquals, assertStringIncludes } from "@std/assert"
import type { CatalogEntry } from "../catalog.ts"
import type { StackMeta } from "../stack-meta.ts"
import {
  formatCatalogJson,
  formatCatalogTable,
  formatCatalogTree,
  groupByCategory,
  orderCategories,
  toJsonStack,
} from "./list.ts"

/** Build a CatalogEntry from a minimal spec. */
function entry(
  name: string,
  description: string,
  opts: { category?: string; variables?: { key: string; required?: boolean; secret?: boolean }[] } =
    {},
): CatalogEntry {
  const meta: StackMeta = {
    name,
    description,
    category: opts.category,
    variables: (opts.variables ?? []).map((v) => ({
      key: v.key,
      required: v.required ?? true,
      secret: v.secret ?? false,
    })),
  }
  return { meta, dir: `/fake/${name}` }
}

Deno.test("groupByCategory: sorts within each category, unknown → 'other'", () => {
  const entries = [
    entry("zeta", "z", { category: "media" }),
    entry("alpha", "a", { category: "media" }),
    entry("beta", "b"), // no category
    entry("gamma", "g", { category: "monitoring" }),
  ]
  const groups = groupByCategory(entries)
  assertEquals([...groups.keys()], ["media", "other", "monitoring"])
  assertEquals(groups.get("media")?.map((e) => e.meta.name), ["alpha", "zeta"])
  assertEquals(groups.get("other")?.map((e) => e.meta.name), ["beta"])
})

Deno.test("orderCategories: proxy first, then alphabetical", () => {
  const ordered = orderCategories(["monitoring", "media", "proxy", "security"])
  assertEquals(ordered, ["proxy", "media", "monitoring", "security"])
})

Deno.test("orderCategories: leaves categories without 'proxy' untouched", () => {
  const ordered = orderCategories(["zeta", "alpha", "beta"])
  assertEquals(ordered, ["alpha", "beta", "zeta"])
})

Deno.test("formatCatalogTable: groups by category + shows var counts", () => {
  const entries = [
    entry("traefik", "Reverse proxy", {
      category: "proxy",
      variables: [{ key: "A" }, { key: "B" }],
    }),
    entry("gatus", "Health checks", { category: "monitoring", variables: [{ key: "URL" }] }),
  ]
  const out = formatCatalogTable(entries)
  assertStringIncludes(out, "proxy/")
  assertStringIncludes(out, "traefik")
  assertStringIncludes(out, "[2 vars]")
  assertStringIncludes(out, "monitoring/")
  assertStringIncludes(out, "gatus")
  assertStringIncludes(out, "[1 var]") // singular form
})

Deno.test("formatCatalogTable: empty catalog shows placeholder", () => {
  assertEquals(formatCatalogTable([]), "  (catalog empty)")
})

Deno.test("formatCatalogTable: var count shows '(N required)' when not all required", () => {
  const entries = [
    entry("x", "x", { variables: [{ key: "A" }, { key: "B", required: false }] }),
  ]
  const out = formatCatalogTable(entries)
  assertStringIncludes(out, "[2 vars (1 required)]")
})

Deno.test("formatCatalogTree: indented under category headers", () => {
  const entries = [
    entry("traefik", "Reverse proxy", { category: "proxy" }),
    entry("gatus", "Health checks", { category: "monitoring" }),
  ]
  const out = formatCatalogTree(entries)
  // Proxy comes first.
  const proxyIdx = out.indexOf("proxy/")
  const monitorIdx = out.indexOf("monitoring/")
  assertEquals(proxyIdx < monitorIdx, true)
  assertStringIncludes(out, "  └─ traefik: Reverse proxy")
  assertStringIncludes(out, "  └─ gatus: Health checks")
})

Deno.test("toJsonStack: drops defaults, exposes public contract", () => {
  const entries = [
    entry("traefik", "Reverse proxy", {
      category: "proxy",
      variables: [
        { key: "IMAGE_TAG", required: false },
        { key: "CONTACT_EMAIL", secret: true },
      ],
    }),
  ]
  const json = toJsonStack(entries[0])
  assertEquals(json, {
    name: "traefik",
    description: "Reverse proxy",
    category: "proxy",
    variables: [
      { key: "IMAGE_TAG", required: false, secret: false },
      { key: "CONTACT_EMAIL", required: true, secret: true },
    ],
  })
})

Deno.test("formatCatalogJson: produces valid JSON array", () => {
  const entries = [entry("traefik", "Reverse proxy", { category: "proxy" })]
  const out = formatCatalogJson(entries)
  const parsed = JSON.parse(out)
  assertEquals(Array.isArray(parsed), true)
  assertEquals(parsed.length, 1)
  assertEquals(parsed[0].name, "traefik")
})

Deno.test("formatCatalogJson: omits category when undefined (not 'undefined')", () => {
  const entries = [entry("orphan", "no category")]
  const parsed = JSON.parse(formatCatalogJson(entries))
  assertEquals(parsed[0].category, undefined)
  assertEquals("category" in parsed[0], false)
})
