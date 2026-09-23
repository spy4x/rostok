import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { UserError } from "../errors.ts"
import { resolveStackFiles } from "./stack-files.ts"

Deno.test("resolveStackFiles: prefers <project>/stacks/<name>/ when it exists", async () => {
  const dir = await Deno.makeTempDir({ prefix: "rostok-stack-files-" })
  try {
    const stackDir = join(dir, "stacks", "custom")
    await Deno.mkdir(join(stackDir, "sub"), { recursive: true })
    await Deno.writeTextFile(join(stackDir, "compose.yml"), "services: {}\n")
    await Deno.writeTextFile(join(stackDir, "sub", "extra.yml"), "x: 1\n")

    const result = await resolveStackFiles(dir, "custom")
    assertEquals(result.origin, "local")
    assertEquals([...result.files.keys()].sort(), ["compose.yml", "sub/extra.yml"])
    for (const url of result.files.values()) {
      assertStringIncludes(url, "file://")
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("resolveStackFiles: falls back to the bundled catalog manifest", async () => {
  const dir = await Deno.makeTempDir({ prefix: "rostok-stack-files-" })
  try {
    // No stacks/traefik/ in this project — must resolve to the shipped files.
    const result = await resolveStackFiles(dir, "traefik")
    assertEquals(result.origin, "shipped")
    assertEquals(result.files.has("compose.yml"), true)
    assertEquals(result.files.has("before.deploy.ts"), true)
    assertEquals(result.files.has("dynamic/00-base.yml"), true)
    for (const url of result.files.values()) {
      // Resolved via import.meta.resolve — file:// in this dev checkout,
      // https:// once installed from JSR.
      assertEquals(url.startsWith("file://") || url.startsWith("https://"), true)
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("resolveStackFiles: throws for a stack that is neither local nor bundled", async () => {
  const dir = await Deno.makeTempDir({ prefix: "rostok-stack-files-" })
  try {
    const err = await assertRejects(
      () => resolveStackFiles(dir, "ghost-stack"),
      UserError,
    )
    assertStringIncludes(err.message, "ghost-stack")
    assertStringIncludes(err.message, "isn't part of the bundled catalog")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
