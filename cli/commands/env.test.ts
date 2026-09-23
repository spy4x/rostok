// Tests for cli/commands/env.ts — runEnvSetup is the testable core of
// `rostok env setup`, kept separate from the Command so tests can call
// it without triggering the action's Deno.exit().

import { assertEquals } from "@std/assert"
import { join } from "@std/path"
import { runEnvSetup } from "./env.ts"

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-env-setup-" })
  try {
    return await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {})
  }
}

Deno.test("runEnvSetup: generates a key and gitignores it on a fresh project", async () => {
  await withTmpDir(async (dir) => {
    await Deno.writeTextFile(join(dir, ".gitignore"), ".env\n")
    const result = await runEnvSetup(dir)
    assertEquals(result.ok, true)
    assertEquals(result.alreadyExisted, undefined)
    const keyExists = await Deno.stat(join(dir, ".age", "key.txt")).then(() => true).catch(() =>
      false
    )
    assertEquals(keyExists, true)
    const gitignore = await Deno.readTextFile(join(dir, ".gitignore"))
    assertEquals(gitignore.includes(".age/"), true)
  })
})

// #204 review fix — env setup must backfill the .age/ gitignore rule
// even when a key already exists, since that's the command a 1.0.3
// project (key present, rule missing) is most likely to run again.
Deno.test("runEnvSetup: backfills the gitignore rule even when a key already exists", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, ".age"), { recursive: true })
    await Deno.writeTextFile(join(dir, ".age", "key.txt"), "AGE-SECRET-KEY-placeholder\n")
    await Deno.writeTextFile(join(dir, ".gitignore"), ".env\n.env.root\ndeno.lock\n")

    const result = await runEnvSetup(dir)
    assertEquals(result.ok, true)
    assertEquals(result.alreadyExisted, true)

    const gitignore = await Deno.readTextFile(join(dir, ".gitignore"))
    assertEquals(gitignore.includes(".age/"), true, "the rule must be backfilled")

    // The pre-existing key content is untouched — "no changes made" to the key itself.
    const key = await Deno.readTextFile(join(dir, ".age", "key.txt"))
    assertEquals(key, "AGE-SECRET-KEY-placeholder\n")
  })
})
