// Tests for cli/init.ts — idempotent project skeleton creation.

import { assertEquals, assertExists } from "@std/assert"
import { join } from "@std/path"
import { initProject } from "./init.ts"

Deno.test("initProject: creates skeleton in empty dir", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-init-" })
  try {
    const result = await initProject(tmp)
    // Created: deno.jsonc, .gitignore, servers/, .age/, .age/key.txt, .env.root
    assertEquals(result.created.length, 6)
    assertEquals(result.skipped.length, 0)

    // Verify files exist with expected content.
    const denoJsonc = await Deno.readTextFile(join(tmp, "deno.jsonc"))
    assertExists(denoJsonc.match(/"@rostok\/cli"/))

    const gitignore = await Deno.readTextFile(join(tmp, ".gitignore"))
    assertExists(gitignore.match(/\.env\.age/))
    assertExists(gitignore.match(/\.env\.root/))

    const serversStat = await Deno.stat(join(tmp, "servers"))
    assertEquals(serversStat.isDirectory, true)

    const ageDirStat = await Deno.stat(join(tmp, ".age"))
    assertEquals(ageDirStat.isDirectory, true)

    const envRoot = await Deno.readTextFile(join(tmp, ".env.root"))
    assertEquals(envRoot, "")
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("initProject: idempotent — second call skips existing files", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-init-" })
  try {
    await initProject(tmp)
    const second = await initProject(tmp)
    assertEquals(second.created.length, 0)
    assertEquals(second.skipped.length, 6)
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("initProject: detects existing .git/ and reports gitInitialized=true", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-init-" })
  try {
    await Deno.mkdir(join(tmp, ".git"))
    const result = await initProject(tmp)
    // We don't try `git init` again because .git already exists.
    assertEquals(result.gitInitialized, true)
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})
