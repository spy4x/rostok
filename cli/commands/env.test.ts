// Tests for cli/commands/env.ts — runEnvSetup is the testable core of
// `rostok env setup`, kept separate from the Command so tests can call
// it without triggering the action's Deno.exit().

import { assertEquals, assertStringIncludes } from "@std/assert"
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

    // The pre-existing key content is untouched.
    const key = await Deno.readTextFile(join(dir, ".age", "key.txt"))
    assertEquals(key, "AGE-SECRET-KEY-placeholder\n")

    // Review fix — .gitignore DID change this run, so "no changes made"
    // would be false. The message must say the key specifically (not
    // everything) was left alone.
    assertEquals(
      result.lines.some((l) => l.includes("no changes made")),
      false,
      "must not claim nothing changed when .gitignore was just backfilled",
    )
    assertEquals(result.lines.some((l) => l.includes("key left unchanged")), true)
  })
})

// Review fix — when NOTHING changes (key present, .gitignore already
// covers .age/), the original "no changes made" wording is still
// accurate and should still be used.
Deno.test("runEnvSetup: says 'no changes made' when the gitignore rule was already there", async () => {
  await withTmpDir(async (dir) => {
    await Deno.mkdir(join(dir, ".age"), { recursive: true })
    await Deno.writeTextFile(join(dir, ".age", "key.txt"), "AGE-SECRET-KEY-placeholder\n")
    await Deno.writeTextFile(join(dir, ".gitignore"), ".env\n.age/\n")

    const result = await runEnvSetup(dir)
    assertEquals(result.ok, true)
    assertEquals(result.alreadyExisted, true)
    assertEquals(result.lines.some((l) => l.includes("no changes made")), true)
    assertEquals(result.lines.some((l) => l.includes("key left unchanged")), false)
  })
})

// #236 — in a linked worktree with no key of its own, `resolveKeyFile`
// (cli/age.ts) falls back to the MAIN checkout's key. The old message
// hardcoded `<cwd>/.age/key.txt` regardless — naming a path that had no
// file on it at all, while the key actually found lived elsewhere. This
// builds a real main checkout + linked worktree (never the real repo —
// a throwaway pair in its own temp dir) and asserts the message names
// the MAIN checkout's path.
// A parent git process (this repo's own pre-commit hook, or a shell with
// GIT_DIR exported by hand) could otherwise redirect these fixture git
// spawns at a completely different repo — see cli/age.test.ts's own
// version of this helper for the incident that made this necessary.
function strippedGitEnv(): Record<string, string> {
  const env = Deno.env.toObject()
  for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) {
    delete env[key]
  }
  return env
}

async function gitQuiet(cwd: string, ...args: string[]): Promise<void> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    env: strippedGitEnv(),
    clearEnv: true,
    stdout: "null",
    stderr: "piped",
  }).output()
  if (!out.success) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(out.stderr)}`)
  }
}

Deno.test("runEnvSetup: in a worktree without its own key, names the MAIN checkout's key path, not the worktree's", async () => {
  const root = await Deno.makeTempDir({ prefix: "rostok-env-setup-worktree-" })
  try {
    const main = join(root, "main")
    const worktree = join(root, "worktree")
    await Deno.mkdir(main, { recursive: true })
    await gitQuiet(main, "init", "-q")
    await Deno.writeTextFile(join(main, "README.md"), "x\n")
    await gitQuiet(main, "add", "README.md")
    await gitQuiet(
      main,
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=test",
      "commit",
      "-q",
      "-m",
      "init",
    )
    await Deno.mkdir(join(main, ".age"), { recursive: true })
    await Deno.writeTextFile(join(main, ".age", "key.txt"), "AGE-SECRET-KEY-placeholder\n")
    await gitQuiet(main, "worktree", "add", "-q", "--detach", worktree, "HEAD")

    // Note: no .age/key.txt in `worktree` — resolveKeyFile must fall
    // back to `main`'s.
    const result = await runEnvSetup(worktree)
    assertEquals(result.ok, true)
    assertEquals(result.alreadyExisted, true)
    const messageLine = result.lines.find((l) => l.includes("already exists at"))
    assertStringIncludes(messageLine ?? "", join(main, ".age", "key.txt"))
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {})
  }
})

// #212 — `rostok env encrypt` with no key points at `rostok env setup`,
// never at the raw `age-keygen` command a hobbyist shouldn't have to
// know exists. Runs the real binary since envEncryptCommand's action
// (unlike runEnvSetup) isn't split out into a testable function — it
// calls Deno.exit directly.
Deno.test("env encrypt: with no key, points at `rostok env setup`, not raw age-keygen", async () => {
  await withTmpDir(async (dir) => {
    const mainTs = join(import.meta.dirname!, "..", "+main.ts")
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", mainTs, "env", "encrypt"],
      cwd: dir,
      stdout: "null",
      stderr: "piped",
    })
    const out = await cmd.output()
    const stderr = new TextDecoder().decode(out.stderr)
    assertEquals(out.code, 1)
    assertEquals(stderr.includes("rostok env setup"), true, stderr)
    assertEquals(stderr.includes("age-keygen"), false, stderr)
  })
})
