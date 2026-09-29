// A hook runs from its jsr.io URL, outside the package's module graph, so
// the import map in deno.jsonc does not apply to it. A bare specifier
// like `"yaml"` fails there with `Import "yaml" not a dependency`.
// Every import in a `*.deploy.ts` hook, and in each file it imports, must be relative, `npm:`,
// `jsr:`, `node:` or a URL.

import { assert, assertEquals } from "@std/assert"
import { fromFileUrl, join } from "@std/path"

/** Import specifiers in `text` that are neither relative nor fully qualified. */
export function findBareImports(text: string): string[] {
  const specs = [
    ...text.matchAll(/^\s*(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/gm),
    ...text.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1])
  return specs.filter((s) => !/^(\.\.?\/|npm:|jsr:|node:|https?:|file:)/.test(s))
}

Deno.test("findBareImports: flags an import-map name, accepts qualified and relative ones", () => {
  const text = [
    `import { parse } from "yaml"`,
    `import { a } from "npm:yaml@2.8.2"`,
    `import { b } from "./b.ts"`,
    `import { c } from "jsr:@std/path"`,
    `import { d } from "node:fs"`,
    `import "side-effect"`,
    `const m = await import("lazy")`,
  ].join("\n")
  assertEquals(findBareImports(text), ["yaml", "side-effect", "lazy"])
})

Deno.test("stacks: no hook, or file a hook imports, uses a bare import specifier", async () => {
  const root = fromFileUrl(new URL("./", import.meta.url))
  const violations: string[] = []
  const seen = new Set<string>()
  async function check(path: string): Promise<void> {
    if (seen.has(path)) return
    seen.add(path)
    const text = await Deno.readTextFile(path)
    for (const s of findBareImports(text)) {
      violations.push(`${path.slice(root.length)} imports "${s}"`)
    }
    for (const m of text.matchAll(/\bfrom\s*["'](\.\.?\/[^"']+\.ts)["']/g)) {
      await check(join(path, "..", m[1]))
    }
  }
  const hooks: string[] = []
  async function walk(dir: string): Promise<void> {
    for await (const e of Deno.readDir(dir)) {
      const p = join(dir, e.name)
      if (e.isDirectory) await walk(p)
      else if (/\.deploy\.ts$/.test(e.name)) hooks.push(p)
    }
  }
  await walk(root)
  assert(hooks.length > 0, "found no *.deploy.ts hooks: is the walk broken?")
  for (const h of hooks) await check(h)
  assertEquals(violations, [])
})
