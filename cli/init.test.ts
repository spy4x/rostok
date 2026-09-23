// Tests for cli/init.ts — idempotent project skeleton creation.

import { assertEquals, assertExists } from "@std/assert"
import { join } from "@std/path"
import { ensureAgeIgnored, initProject } from "./init.ts"
import { generateAgeKey } from "./encrypt.ts"

Deno.test("initProject: creates skeleton in empty dir", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-init-" })
  try {
    const result = await initProject(tmp)
    // Created: deno.jsonc, .gitignore, servers/, .env.root (4 files)
    assertEquals(result.created.length, 4)
    assertEquals(result.skipped.length, 0)

    // Verify files exist with expected content.
    const denoJsonc = await Deno.readTextFile(join(tmp, "deno.jsonc"))
    assertExists(denoJsonc.match(/"@rostok\/cli"/))

    const gitignore = await Deno.readTextFile(join(tmp, ".gitignore"))
    // Plaintext secrets are gitignored.
    assertExists(gitignore.match(/^\.env$/m))
    assertExists(gitignore.match(/^\.env\.root$/m))
    // Encrypted blobs are NOT gitignored — safe to commit.
    assertEquals(gitignore.match(/\.env\.age/), null)
    assertEquals(gitignore.match(/\.env\.root\.age/), null)
    // #204: the private key directory IS gitignored from the start.
    assertExists(gitignore.match(/^\.age\/$/m))

    const serversStat = await Deno.stat(join(tmp, "servers"))
    assertEquals(serversStat.isDirectory, true)

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
    assertEquals(second.skipped.length, 4)
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

// #204 — the generated .gitignore must actually keep the private key out
// of git, not just claim to.

async function gitCheckIgnoresAgeKey(cwd: string): Promise<boolean> {
  const cmd = new Deno.Command("git", {
    args: ["check-ignore", "-q", ".age/key.txt"],
    cwd,
    stdout: "null",
    stderr: "null",
  })
  return (await cmd.output()).success
}

Deno.test("initProject + key generation leaves .age/key.txt gitignored", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-init-age-" })
  try {
    await new Deno.Command("git", { args: ["init"], cwd: tmp, stdout: "null", stderr: "null" })
      .output()
    await initProject(tmp)
    const key = await generateAgeKey(tmp)
    assertEquals(key.ok, true)
    assertEquals(await gitCheckIgnoresAgeKey(tmp), true)
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("initProject backfills the .age/ rule into a 1.0.3-style .gitignore", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-init-age-" })
  try {
    await new Deno.Command("git", { args: ["init"], cwd: tmp, stdout: "null", stderr: "null" })
      .output()
    // Simulate a project created by 1.0.0–1.0.3: .gitignore exists but
    // predates the .age/ rule.
    await Deno.writeTextFile(join(tmp, ".gitignore"), ".env\n.env.root\ndeno.lock\n")
    assertEquals(await gitCheckIgnoresAgeKey(tmp), false, "precondition: not yet ignored")

    const result = await initProject(tmp)
    // .gitignore already existed — init leaves its content alone except
    // for the backfilled rule.
    assertExists(result.skipped.find((p) => p.endsWith(".gitignore")))
    assertEquals(await gitCheckIgnoresAgeKey(tmp), true)

    const gitignore = await Deno.readTextFile(join(tmp, ".gitignore"))
    assertExists(gitignore.match(/^\.age\/$/m))
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("ensureAgeIgnored: no-op when already covered, reports added=false", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-init-age-" })
  try {
    await Deno.writeTextFile(join(tmp, ".gitignore"), ".env\n.age/\n")
    const result = await ensureAgeIgnored(tmp)
    assertEquals(result.added, false)
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("ensureAgeIgnored: appends the rule and reports added=true without git", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-init-age-" })
  try {
    await Deno.writeTextFile(join(tmp, ".gitignore"), ".env\n")
    const result = await ensureAgeIgnored(tmp)
    assertEquals(result.added, true)
    const gitignore = await Deno.readTextFile(join(tmp, ".gitignore"))
    assertExists(gitignore.match(/^\.age\/$/m))
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})
