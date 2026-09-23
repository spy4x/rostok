// Tests for cli/catalog-paths.ts — #208: --catalog must resolve to an
// existing directory.

import { assertEquals, assertRejects } from "@std/assert"
import { join } from "@std/path"
import { UserError } from "./errors.ts"
import { loadCatalogFromDir } from "./catalog-paths.ts"

Deno.test("loadCatalogFromDir: throws UserError for a directory that doesn't exist", async () => {
  await assertRejects(
    () => loadCatalogFromDir("/nonexistent/definitely/not/here"),
    UserError,
    "--catalog directory not found",
  )
})

Deno.test("loadCatalogFromDir: throws UserError when --catalog points at a file", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-catalog-" })
  try {
    const filePath = join(tmp, "not-a-dir")
    await Deno.writeTextFile(filePath, "")
    await assertRejects(
      () => loadCatalogFromDir(filePath),
      UserError,
      "--catalog must be a directory",
    )
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("loadCatalogFromDir: loads a valid fixture catalog", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-catalog-" })
  try {
    await Deno.mkdir(join(tmp, "demo"), { recursive: true })
    await Deno.writeTextFile(
      join(tmp, "demo", "+meta.ts"),
      `import type { StackMeta } from "@rostok/cli"
export default {
  name: "demo",
  description: "fixture",
  variables: [],
} satisfies StackMeta
`,
    )
    const entries = await loadCatalogFromDir(tmp)
    assertEquals(entries.length, 1)
    assertEquals(entries[0].name, "demo")
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

// #208 review fix — a relative --catalog path used to crash inside the
// dynamic import with "Could not convert URL to file path", because a
// relative path fed straight into `new URL("file://" + path)` puts the
// first path segment in the URL's host instead of its path.
Deno.test("loadCatalogFromDir: resolves a relative path against cwd", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-catalog-" })
  const originalCwd = Deno.cwd()
  try {
    await Deno.mkdir(join(tmp, "catalog", "demo"), { recursive: true })
    await Deno.writeTextFile(
      join(tmp, "catalog", "demo", "+meta.ts"),
      `import type { StackMeta } from "@rostok/cli"
export default {
  name: "demo",
  description: "fixture",
  variables: [],
} satisfies StackMeta
`,
    )
    Deno.chdir(tmp)
    const entries = await loadCatalogFromDir("catalog")
    assertEquals(entries.length, 1)
    assertEquals(entries[0].name, "demo")
  } finally {
    Deno.chdir(originalCwd)
    await Deno.remove(tmp, { recursive: true })
  }
})
