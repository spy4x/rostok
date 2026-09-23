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
