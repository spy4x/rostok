// Keeps docs/usage/security-matrix.md in step with the catalog: one row per stack directory.

import { assertEquals } from "@std/assert"

const stacksDir = new URL("./", import.meta.url)
const matrix = new URL("../docs/usage/security-matrix.md", import.meta.url)

Deno.test("security matrix has exactly one row per stack directory", async () => {
  const stacks: string[] = []
  for await (const entry of Deno.readDir(stacksDir)) {
    if (entry.isDirectory) stacks.push(entry.name)
  }
  const text = await Deno.readTextFile(matrix)
  const rows = [...text.matchAll(/^\| \[([a-z0-9-]+)\]\(\.\.\/\.\.\/stacks\/\1\/README\.md\) \|/gm)]
    .map((m) => m[1])
  assertEquals(rows.sort(), stacks.sort())
})
