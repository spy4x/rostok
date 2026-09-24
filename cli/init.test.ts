// Tests for cli/init.ts — idempotent project skeleton creation.

import { assertEquals, assertExists } from "@std/assert"
import { join } from "@std/path"
import { ensureAgeIgnored, initProject } from "./init.ts"
import { generateAgeKey } from "@spy4x/server/env-age64"

// #236 item 1 — a parent git process (this repo's own pre-commit hook, or a
// shell with GIT_DIR exported by hand) can point every git invocation in
// this file at a completely different repo, regardless of `cwd`. Before
// this fix, this file's own `git init`/`git add` fixture setup inherited
// that GIT_DIR and staged `.age/key.txt` into the OTHER repo's index and
// flipped its `core.bare`. cli/age.test.ts hit the same failure mode
// first — this mirrors its fix: every git spawn here (this file's own
// fixture setup, and the git-touching init.ts functions under test)
// clears these four vars for its duration.
const GIT_ENV_POISON = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]

function strippedGitEnv(): Record<string, string> {
  const env = Deno.env.toObject()
  for (const key of GIT_ENV_POISON) delete env[key]
  return env
}

/** Set `vars` in this process's env for the duration of `fn`, restoring afterward. */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = new Map(Object.keys(vars).map((k) => [k, Deno.env.get(k)]))
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) Deno.env.delete(k)
    else Deno.env.set(k, v)
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) Deno.env.delete(k)
      else Deno.env.set(k, v)
    }
  }
}

/**
 * `initProject`/`ensureAgeIgnored` spawn git with no env override of their
 * own (see cli/init.ts — out of scope for this wave's #236 item), so they
 * inherit whatever GIT_DIR/etc this process currently has. Wrapping the
 * call in NO_GIT_ENV guarantees the git commands they run underneath
 * resolve against `cwd`, not a poisoned GIT_DIR, regardless of what the
 * ambient environment happens to carry.
 */
const NO_GIT_ENV = {
  GIT_DIR: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
}

function withoutGitEnv<T>(fn: () => Promise<T>): Promise<T> {
  return withEnv(NO_GIT_ENV, fn)
}

/** Runs a fixture-setup git command in `cwd`, immune to an inherited GIT_DIR/etc. */
async function gitFixture(cwd: string, ...args: string[]): Promise<void> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    env: strippedGitEnv(),
    clearEnv: true,
    stdout: "null",
    stderr: "null",
  }).output()
  if (!out.success) throw new Error(`git ${args.join(" ")} failed in ${cwd}`)
}

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

    // #212: initProject no longer runs the key-generation prompt itself
    // — it only signals the caller should offer it, once the caller has
    // printed what was just created.
    assertEquals(result.shouldOfferKeyGeneration, true)
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("initProject: idempotent — second call skips existing files and doesn't re-offer key generation", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-init-" })
  try {
    await initProject(tmp)
    const second = await initProject(tmp)
    assertEquals(second.created.length, 0)
    assertEquals(second.skipped.length, 4)
    assertEquals(second.shouldOfferKeyGeneration, false)
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
  return await withoutGitEnv(async () => {
    const cmd = new Deno.Command("git", {
      args: ["check-ignore", "-q", ".age/key.txt"],
      cwd,
      env: strippedGitEnv(),
      clearEnv: true,
      stdout: "null",
      stderr: "null",
    })
    return (await cmd.output()).success
  })
}

Deno.test("initProject + key generation leaves .age/key.txt gitignored", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-init-age-" })
  try {
    await gitFixture(tmp, "init")
    await withoutGitEnv(() => initProject(tmp))
    await generateAgeKey(tmp)
    assertEquals(await gitCheckIgnoresAgeKey(tmp), true)
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("initProject backfills the .age/ rule into a 1.0.3-style .gitignore", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-init-age-" })
  try {
    await gitFixture(tmp, "init")
    // Simulate a project created by 1.0.0–1.0.3: .gitignore exists but
    // predates the .age/ rule.
    await Deno.writeTextFile(join(tmp, ".gitignore"), ".env\n.env.root\ndeno.lock\n")
    assertEquals(await gitCheckIgnoresAgeKey(tmp), false, "precondition: not yet ignored")

    const result = await withoutGitEnv(() => initProject(tmp))
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
    const result = await withoutGitEnv(() => ensureAgeIgnored(tmp))
    assertEquals(result.added, false)
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("ensureAgeIgnored: appends the rule and reports added=true without git", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-init-age-" })
  try {
    await Deno.writeTextFile(join(tmp, ".gitignore"), ".env\n")
    const result = await withoutGitEnv(() => ensureAgeIgnored(tmp))
    assertEquals(result.added, true)
    const gitignore = await Deno.readTextFile(join(tmp, ".gitignore"))
    assertExists(gitignore.match(/^\.age\/$/m))
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

// Security review — a gitignore rule can't undo a key that's already
// tracked (staged or committed) by git; warn instead of silently
// making the project merely look fixed.

async function withGitCapture<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
  try {
    const result = await fn()
    return { result, warnings }
  } finally {
    console.warn = originalWarn
  }
}

Deno.test("ensureAgeIgnored: warns when .age/key.txt is already tracked by git", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-init-age-" })
  try {
    await gitFixture(tmp, "init")
    await Deno.mkdir(join(tmp, ".age"), { recursive: true })
    await Deno.writeTextFile(join(tmp, ".age", "key.txt"), "AGE-SECRET-KEY-placeholder\n")
    await gitFixture(tmp, "add", ".age/key.txt")

    const { result, warnings } = await withGitCapture(() =>
      withoutGitEnv(() => ensureAgeIgnored(tmp))
    )
    assertEquals(result.tracked, true)
    assertEquals(
      warnings.some((w) => w.includes("git rm --cached")),
      true,
      warnings.join("\n"),
    )
    // Still backfills the rule so a future `git add .` can't re-track it.
    const gitignore = await Deno.readTextFile(join(tmp, ".gitignore"))
    assertExists(gitignore.match(/^\.age\/$/m))
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("ensureAgeIgnored: no tracked-key warning for an untracked key", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-init-age-" })
  try {
    await gitFixture(tmp, "init")
    await Deno.mkdir(join(tmp, ".age"), { recursive: true })
    await Deno.writeTextFile(join(tmp, ".age", "key.txt"), "AGE-SECRET-KEY-placeholder\n")
    // Note: never `git add`-ed — present on disk, not staged.

    const { result, warnings } = await withGitCapture(() =>
      withoutGitEnv(() => ensureAgeIgnored(tmp))
    )
    assertEquals(result.tracked, false)
    assertEquals(warnings.length, 0, warnings.join("\n"))
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})
