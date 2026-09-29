// A hook runs from its jsr.io URL, outside the package's module graph, so
// the import map in deno.jsonc does not apply to it. A bare specifier
// like `"yaml"` fails there with `Import "yaml" not a dependency`.
// Every import in a `*.deploy.ts` hook, and in each file it imports, must be relative, `npm:`,
// `jsr:`, `node:` or a URL. A relative import must also stay inside the hook's own stack folder:
// only `stacks/<name>/` ships with the hook, so `../../scripts/+lib.ts` does not exist there.

import { assert, assertEquals } from "@std/assert"
import { fromFileUrl, join, relative, resolve, SEPARATOR } from "@std/path"

/** Every module specifier a text imports, exports from or dynamically imports. */
function importSpecifiers(text: string): string[] {
  return [
    ...text.matchAll(/^\s*(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/gm),
    ...text.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1])
}

/** Import specifiers in `text` that are neither relative nor fully qualified. */
export function findBareImports(text: string): string[] {
  return importSpecifiers(text).filter((s) => !/^(\.\.?\/|npm:|jsr:|node:|https?:|file:)/.test(s))
}

/**
 * Relative import specifiers in `text`, a file in `fileDir`, that resolve outside `stackDir`.
 * Both are absolute directory paths.
 */
export function findEscapingImports(text: string, fileDir: string, stackDir: string): string[] {
  return importSpecifiers(text).filter((s) => {
    if (!/^\.\.?\//.test(s)) return false
    return !(resolve(fileDir, s) + SEPARATOR).startsWith(resolve(stackDir) + SEPARATOR)
  })
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

Deno.test("findEscapingImports: flags a relative import that leaves the stack folder", () => {
  const text = [
    `import { a } from "./a.ts"`,
    `import { b } from "./lib/b.ts"`,
    `import { c } from "../../scripts/+lib.ts"`,
    `import { d } from "../other/d.ts"`,
    `import { e } from "npm:yaml@2.8.2"`,
    `const m = await import("../../x.ts")`,
  ].join("\n")
  assertEquals(findEscapingImports(text, "/repo/stacks/piped", "/repo/stacks/piped"), [
    "../../scripts/+lib.ts",
    "../other/d.ts",
    "../../x.ts",
  ])
  assertEquals(
    findEscapingImports(`import "../piped-x/a.ts"`, "/repo/stacks/piped", "/repo/stacks/piped"),
    ["../piped-x/a.ts"],
  )
  assertEquals(
    findEscapingImports(`import "../a.ts"`, "/repo/stacks/piped/sub", "/repo/stacks/piped"),
    [],
  )
})

Deno.test("stacks: no hook, or file a hook imports, uses a bare or out-of-folder import", async () => {
  const root = fromFileUrl(new URL("./", import.meta.url))
  const violations: string[] = []
  const seen = new Set<string>()
  const repoRoot = resolve(root, "..")
  async function check(path: string, stackDir: string): Promise<void> {
    if (seen.has(path)) return
    seen.add(path)
    const text = await Deno.readTextFile(path)
    for (const s of findBareImports(text)) {
      violations.push(`${relative(repoRoot, path)} imports "${s}"`)
    }
    for (const s of findEscapingImports(text, join(path, ".."), stackDir)) {
      const target = relative(repoRoot, resolve(path, "..", s))
      violations.push(
        `${relative(repoRoot, path)} imports "${s}", which is ${target}, outside ` +
          `${relative(repoRoot, stackDir)}${SEPARATOR}`,
      )
    }
    for (const m of text.matchAll(/\bfrom\s*["'](\.\.?\/[^"']+\.ts)["']/g)) {
      await check(join(path, "..", m[1]), stackDir)
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
  for (const h of hooks) await check(h, join(root, relative(root, h).split(SEPARATOR)[0]))
  assertEquals(violations, [])
})
