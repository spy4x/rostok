import { assertEquals } from "@std/assert"
import { loadCatalog } from "../catalog.ts"
import { SHIPPED_STACK_FILES } from "./shipped-stacks.ts"

const EXCLUDED_NAMES = new Set(["+meta.ts", "backup.ts", "README.md"])

/** Every non-doc, non-test, non-+meta.ts file under a stack dir, relative to it. */
async function collectDeployFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = []
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isDirectory) {
      out.push(...await collectDeployFiles(`${dir}/${entry.name}`, `${prefix}${entry.name}/`))
      continue
    }
    if (!entry.isFile) continue
    if (EXCLUDED_NAMES.has(entry.name) || entry.name.endsWith(".test.ts")) continue
    out.push(`${prefix}${entry.name}`)
  }
  return out
}

Deno.test("shipped-stacks manifest matches every file on disk", async () => {
  const stacksRoot = new URL("../../stacks/", import.meta.url)
  for (const [stackName, files] of Object.entries(SHIPPED_STACK_FILES)) {
    const stackDir = new URL(`${stackName}/`, stacksRoot)
    const onDisk = await collectDeployFiles(stackDir.pathname)
    assertEquals(
      [...onDisk].sort(),
      [...files].sort(),
      `stacks/${stackName}: disk has files the manifest in cli/deploy/shipped-stacks.ts doesn't list (or vice versa)`,
    )
  }
})

Deno.test("shipped-stacks manifest covers every bundled catalog stack", () => {
  const catalogNames = loadCatalog().map((e) => e.name).sort()
  const manifestNames = Object.keys(SHIPPED_STACK_FILES).sort()
  assertEquals(
    manifestNames,
    catalogNames,
    "cli/deploy/shipped-stacks.ts must list exactly the stacks in cli/catalog.ts",
  )
})

Deno.test("shipped-stacks manifest matches deno.jsonc's publish.exclude re-includes", async () => {
  // deno.jsonc's `publish.exclude` excludes all of stacks/** and then
  // re-includes each file individually (`!stacks/<name>/<file>`) — JSR's
  // negation doesn't follow gitignore semantics for nested dirs, so this
  // list is maintained by hand and has to be kept in sync with the
  // manifest below by hand too. This test is that sync check: every
  // manifest entry needs a matching re-include line, and every
  // `!stacks/...` re-include line needs a matching manifest entry.
  const denoJsoncPath = new URL("../../deno.jsonc", import.meta.url)
  const denoJsoncText = await Deno.readTextFile(denoJsoncPath)

  const reincludedInDenoJsonc = new Set<string>()
  for (const m of denoJsoncText.matchAll(/"!stacks\/([^"]+)"/g)) {
    // +meta.ts re-includes are a separate, unrelated mechanism (every
    // catalog stack ships its +meta.ts regardless of deploy needs) — not
    // part of this manifest, so they're not part of this check either.
    if (m[1].endsWith("/+meta.ts")) continue
    reincludedInDenoJsonc.add(`stacks/${m[1]}`)
  }

  const expectedFromManifest = new Set<string>()
  for (const [stackName, files] of Object.entries(SHIPPED_STACK_FILES)) {
    for (const file of files) {
      expectedFromManifest.add(`stacks/${stackName}/${file}`)
    }
  }

  assertEquals(
    [...reincludedInDenoJsonc].sort(),
    [...expectedFromManifest].sort(),
    "deno.jsonc publish.exclude's `!stacks/...` re-includes must match " +
      "cli/deploy/shipped-stacks.ts's SHIPPED_STACK_FILES exactly (each stack's +meta.ts is separate — it's excluded from this manifest and this check on purpose)",
  )
})
