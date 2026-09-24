// Tests for cli/age.ts's key-file resolution (resolveKeyFile) — the
// #226 review round found a real bug here: the key used to resolve via
// `git rev-parse --git-common-dir` run with the process's OWN inherited
// environment and Deno.cwd() (never an explicit cwd), cached
// process-globally. A parent process — a pre-commit hook running its
// own git command, for instance — can export GIT_DIR/GIT_COMMON_DIR/
// GIT_WORK_TREE/GIT_INDEX_FILE to point ITS git invocation at a specific
// repo; git honours those regardless of cwd, so inheriting them here
// would resolve (and read) a completely different repo's `.age/key.txt`
// — silently, and with no error. These tests prove the fix without ever
// touching the real project's own key.

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert"
import { fromFileUrl, join } from "@std/path"
import { generateAgeKey } from "./encrypt.ts"
import { getAgePublicKey, resolveKeyFile } from "./age.ts"

/**
 * Env vars a PARENT git process (this repo's own pre-commit hook, which
 * runs `deno task check` — i.e. THESE TESTS — mid-commit) may have set
 * to point ITS git invocation at the real repo/worktree/index being
 * committed. A real security review of an earlier round of this PR
 * caught exactly this: running these tests as part of a live `git
 * commit` (via the pre-commit hook) let this file's OWN `git` spawns
 * inherit that repo's GIT_DIR/GIT_INDEX_FILE, so `initRepoWithCommit`
 * below committed a stray "init" commit and overwrote README.md on the
 * REAL branch being committed, and `git config` rewrote its real
 * `.git/config`. Every git spawn in this file strips these first, and
 * `-c user.name=/-c user.email=` (never `git config`, which would write
 * to whatever `.git/config` GIT_DIR — stripped or not — resolves to)
 * keep every mutation scoped to the one-off commit invocation itself.
 */
const GIT_ENV_POISON = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]

function strippedGitEnv(): Record<string, string> {
  const env = Deno.env.toObject()
  for (const key of GIT_ENV_POISON) delete env[key]
  return env
}

/** Runs git in `cwd`, throwing with stderr on failure. Returns trimmed stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    env: strippedGitEnv(),
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output()
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim()
  if (!out.success) throw new Error(`git ${args.join(" ")} failed: ${decode(out.stderr)}`)
  return decode(out.stdout)
}

/**
 * A throwaway git repo with one commit — `worktree add` needs at least
 * one. `-c user.name=`/`-c user.email=` on the commit itself (never
 * `git config`, which would persist to a config file) — see the module
 * comment above for why that distinction matters here.
 */
async function initRepoWithCommit(dir: string): Promise<void> {
  await git(dir, "init", "-q")
  await Deno.writeTextFile(join(dir, "README.md"), "x\n")
  await git(dir, "add", "README.md")
  await git(
    dir,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=test",
    "commit",
    "-q",
    "-m",
    "init",
  )
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

Deno.test("resolveKeyFile: a local .age/key.txt wins outright, no git involved", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-agekey-local-" })
  try {
    await Deno.mkdir(join(tmp, ".age"))
    await Deno.writeTextFile(join(tmp, ".age", "key.txt"), "placeholder")
    assertEquals(resolveKeyFile(tmp), join(tmp, ".age", "key.txt"))
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("resolveKeyFile: falls back to <cwd>/.age/key.txt when cwd isn't a git repo and has no local key", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-agekey-nogit-" })
  try {
    assertEquals(resolveKeyFile(tmp), join(tmp, ".age", "key.txt"))
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("resolveKeyFile: a linked worktree with no key of its own falls back to the main checkout's", async () => {
  const root = await Deno.makeTempDir({ prefix: "rostok-agekey-worktree-" })
  const main = join(root, "main")
  const worktree = join(root, "worktree")
  try {
    await Deno.mkdir(main)
    await initRepoWithCommit(main)
    await Deno.mkdir(join(main, ".age"))
    await Deno.writeTextFile(join(main, ".age", "key.txt"), "main-checkout-key")
    await git(main, "worktree", "add", "--detach", worktree)

    // The worktree itself has no .age/key.txt — resolution must fall
    // through git's own --git-common-dir to the main checkout's.
    assertEquals(resolveKeyFile(worktree), join(main, ".age", "key.txt"))
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test(
  "resolveKeyFile: GIT_DIR pointing at a decoy repo skips the git lookup entirely, never reads the decoy's key (#226 review round)",
  async () => {
    // resolveKeyFile can't safely strip GIT_DIR/etc. from a git
    // subprocess's env without reconstructing the whole environment
    // (Deno.Command's clearEnv needs a full Deno.env.toObject(), the
    // broad --allow-env grant this module deliberately avoids asking
    // for — see anyGitEnvPoisoned's own comment). So when poisoned, it
    // refuses to trust git's answer at all and falls straight back to
    // the plain <cwd>/.age/key.txt path — worse for a poisoned worktree
    // with no local key of its own (it won't find the main checkout's
    // key either), but never wrong: it can never resolve to the decoy's
    // key, only to a path that may not exist.
    const root = await Deno.makeTempDir({ prefix: "rostok-agekey-gitdir-poison-" })
    const main = join(root, "main")
    const worktree = join(root, "worktree")
    const decoy = join(root, "decoy")
    try {
      await Deno.mkdir(main)
      await initRepoWithCommit(main)
      await Deno.mkdir(join(main, ".age"))
      await Deno.writeTextFile(join(main, ".age", "key.txt"), "main-checkout-key")
      await git(main, "worktree", "add", "--detach", worktree)

      await Deno.mkdir(decoy)
      await initRepoWithCommit(decoy)
      await Deno.mkdir(join(decoy, ".age"))
      await Deno.writeTextFile(join(decoy, ".age", "key.txt"), "decoy-key-must-never-be-read")

      const decoyGitDir = join(decoy, ".git")

      // Simulates a parent process (a pre-commit hook running `git
      // commit` in a different repo, for instance) that has exported
      // these to steer ITS OWN git invocation — inheriting them here
      // would resolve `worktree`'s key against `decoy` instead.
      await withEnv(
        {
          GIT_DIR: decoyGitDir,
          GIT_COMMON_DIR: decoyGitDir,
          GIT_WORK_TREE: decoy,
          GIT_INDEX_FILE: join(decoyGitDir, "index"),
        },
        () => {
          // Never the decoy's key, and — since it can't safely ask git
          // either — not the main checkout's key here either: the
          // plain (nonexistent) local path.
          const resolved = resolveKeyFile(worktree)
          assertEquals(resolved, join(worktree, ".age", "key.txt"))
          assertNotEquals(resolved, join(decoy, ".age", "key.txt"))
          return Promise.resolve()
        },
      )
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  },
)

Deno.test(
  "resolveKeyFile: cwd with its own local key ignores GIT_DIR poisoning entirely (no git subprocess needed)",
  async () => {
    const tmp = await Deno.makeTempDir({ prefix: "rostok-agekey-local-poison-" })
    const decoy = await Deno.makeTempDir({ prefix: "rostok-agekey-decoy-" })
    try {
      await Deno.mkdir(join(tmp, ".age"))
      await Deno.writeTextFile(join(tmp, ".age", "key.txt"), "own-key")
      await initRepoWithCommit(decoy)
      await Deno.mkdir(join(decoy, ".age"))
      await Deno.writeTextFile(join(decoy, ".age", "key.txt"), "decoy-key-must-never-be-read")

      await withEnv({ GIT_DIR: join(decoy, ".git") }, () => {
        assertEquals(resolveKeyFile(tmp), join(tmp, ".age", "key.txt"))
        return Promise.resolve()
      })
    } finally {
      await Deno.remove(tmp, { recursive: true })
      await Deno.remove(decoy, { recursive: true })
    }
  },
)

// End-to-end proof through the real encrypt path: a worktree with no
// key of its own, GIT_DIR poisoned at a decoy repo, never encrypts for
// the decoy's key. Since resolving the git-common-dir lookup is skipped
// entirely under poisoning (see resolveKeyFile's own comment), this
// case can't find the main checkout's key either — it fails loudly
// (ok:false, skipped:"no-key"), which is the safe outcome: no file is
// ever written with the wrong key.
Deno.test(
  "encryptEnvFiles: a poisoned GIT_DIR never causes encryption for the decoy's key (#226 review round)",
  async () => {
    const root = await Deno.makeTempDir({ prefix: "rostok-agekey-e2e-poison-" })
    const main = join(root, "main")
    const worktree = join(root, "worktree")
    const decoy = join(root, "decoy")
    try {
      await Deno.mkdir(main)
      await initRepoWithCommit(main)
      const mainKey = await generateAgeKey(main)
      assertEquals(mainKey.ok, true)
      await git(main, "worktree", "add", "--detach", worktree)

      await Deno.mkdir(decoy)
      await initRepoWithCommit(decoy)
      const decoyKey = await generateAgeKey(decoy)
      assertEquals(decoyKey.ok, true)
      assertNotEquals(mainKey.publicKey, decoyKey.publicKey)

      await Deno.writeTextFile(join(worktree, ".env"), "SECRET=payload\n")

      const decoyGitDir = join(decoy, ".git")
      const { encryptEnvFiles } = await import("./encrypt.ts")
      const encryptResult = await withEnv(
        { GIT_DIR: decoyGitDir, GIT_COMMON_DIR: decoyGitDir, GIT_WORK_TREE: decoy },
        () => encryptEnvFiles(worktree),
      )
      assertEquals(encryptResult.ok, false)
      assertEquals(encryptResult.skipped, "no-key")

      // No .env.age was written at all — never with the decoy's key.
      await assertRejects(() => Deno.stat(join(worktree, ".env.age")))
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  },
)

// #226 review round: `deno task env:encrypt`/`env:decrypt` (deno.jsonc)
// grant NEITHER blanket nor scoped --allow-env. In a git repo with no
// local .age/key.txt, resolveKeyFile's anyGitEnvPoisoned() check throws
// Deno.errors.NotCapable — this must surface as a loud subprocess
// failure (non-zero exit), never a silent "no key, exit 0" that skips
// writing .env.age without saying why.
Deno.test("encryptEnvFiles: without any --allow-env, a missing local key fails loudly, not silently (#226 review round)", async () => {
  const repo = await Deno.makeTempDir({ prefix: "rostok-agekey-noenv-perm-" })
  try {
    await initRepoWithCommit(repo)
    await Deno.writeTextFile(join(repo, ".env"), "SECRET=payload\n")

    const script = `
      import { encryptEnvFiles } from "${new URL("./encrypt.ts", import.meta.url).href}"
      const result = await encryptEnvFiles(${JSON.stringify(repo)})
      console.log(JSON.stringify(result))
    `
    const scriptPath = join(repo, "run.ts")
    await Deno.writeTextFile(scriptPath, script)

    // Deliberately no --allow-env at all (not even scoped) — matches
    // deno task env:encrypt's actual permission set today. --config
    // points at this worktree's own deno.jsonc so `@std/path` etc.
    // resolve — Deno otherwise looks for one next to the entrypoint
    // (`repo`, outside this worktree, has none). encryptEnvFiles is
    // still given `repo` as its own explicit argument regardless.
    const denoConfigPath = fromFileUrl(new URL("../deno.jsonc", import.meta.url))
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--config",
        denoConfigPath,
        "--allow-read",
        "--allow-write",
        "--allow-run=age,git",
        scriptPath,
      ],
      stdout: "piped",
      stderr: "piped",
    })
    const output = await command.output()
    assertEquals(
      output.success,
      false,
      `expected a non-zero exit (a permission error surfacing), got success. ` +
        `stdout: ${new TextDecoder().decode(output.stdout)}`,
    )
    const stderr = new TextDecoder().decode(output.stderr)
    assertEquals(stderr.includes("NotCapable") || stderr.includes("env"), true, stderr)
  } finally {
    await Deno.remove(repo, { recursive: true })
  }
})

// The catch around the git spawn itself only swallows a missing `git`
// binary (Deno.errors.NotFound) — any other spawn failure (denied
// --allow-run, for instance) must surface too, not be treated the same
// as "git isn't installed".
Deno.test("resolveKeyFile: a denied --allow-run=git surfaces, isn't treated like a missing git binary", async () => {
  const repo = await Deno.makeTempDir({ prefix: "rostok-agekey-norun-perm-" })
  try {
    await initRepoWithCommit(repo)

    const script = `
      import { resolveKeyFile } from "${new URL("./age.ts", import.meta.url).href}"
      console.log(resolveKeyFile(${JSON.stringify(repo)}))
    `
    const scriptPath = join(repo, "run.ts")
    await Deno.writeTextFile(scriptPath, script)

    const denoConfigPath = fromFileUrl(new URL("../deno.jsonc", import.meta.url))
    // Full env access, but NO --allow-run at all — git can't even be
    // spawned to check whether it's installed.
    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", "--config", denoConfigPath, "--allow-read", "--allow-env", scriptPath],
      stdout: "piped",
      stderr: "piped",
    })
    const output = await command.output()
    assertEquals(
      output.success,
      false,
      `expected a non-zero exit (the run-permission error surfacing), got success`,
    )
    const stderr = new TextDecoder().decode(output.stderr)
    assertEquals(stderr.includes("NotCapable") || stderr.includes("run"), true, stderr)
  } finally {
    await Deno.remove(repo, { recursive: true })
  }
})

Deno.test("resolveKeyFile: a linked worktree with its OWN key uses it, not the main checkout's (review round)", async () => {
  // The earlier "local key wins" test used a standalone dir with no git
  // repo at all, so it stayed green even if that check were removed —
  // resolveKeyFile would still fall through to the same <cwd>/.age/
  // key.txt path via its final fallback. This test needs the local-key
  // check to actually short-circuit BEFORE the git lookup: a worktree
  // whose own key differs from its main checkout's must resolve to its
  // OWN key, not the main's (which the git-based step 2 would return).
  const root = await Deno.makeTempDir({ prefix: "rostok-agekey-worktree-own-key-" })
  const main = join(root, "main")
  const worktree = join(root, "worktree")
  try {
    await Deno.mkdir(main)
    await initRepoWithCommit(main)
    await Deno.mkdir(join(main, ".age"))
    await Deno.writeTextFile(join(main, ".age", "key.txt"), "main-checkout-key")
    await git(main, "worktree", "add", "--detach", worktree)

    // The worktree copied its OWN key (env-key-copy.ts's job in real
    // use) — different content from main's.
    await Deno.mkdir(join(worktree, ".age"))
    await Deno.writeTextFile(join(worktree, ".age", "key.txt"), "worktrees-own-key")

    assertEquals(resolveKeyFile(worktree), join(worktree, ".age", "key.txt"))
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("getAgePublicKey: the key-file cache is keyed per cwd, not a single global value (review round)", async () => {
  // A single global cache would return the FIRST cwd's key for every
  // later cwd too. Two different projects, each with their own key,
  // resolved in sequence, must each get their own answer.
  const rootA = await Deno.makeTempDir({ prefix: "rostok-agekey-cache-a-" })
  const rootB = await Deno.makeTempDir({ prefix: "rostok-agekey-cache-b-" })
  try {
    const keyA = await generateAgeKey(rootA)
    const keyB = await generateAgeKey(rootB)
    assertEquals(keyA.ok, true)
    assertEquals(keyB.ok, true)
    assertNotEquals(keyA.publicKey, keyB.publicKey)

    // Resolve A first (populates any cache for rootA), then B, then A
    // again — a global (non-keyed) cache would make this last call
    // return B's key instead of A's own.
    assertEquals(getAgePublicKey(rootA), keyA.publicKey)
    assertEquals(getAgePublicKey(rootB), keyB.publicKey)
    assertEquals(getAgePublicKey(rootA), keyA.publicKey)
  } finally {
    await Deno.remove(rootA, { recursive: true })
    await Deno.remove(rootB, { recursive: true })
  }
})
