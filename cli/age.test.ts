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

import { assertEquals, assertNotEquals } from "@std/assert"
import { join } from "@std/path"
import { generateAgeKey } from "./encrypt.ts"
import { resolveKeyFile } from "./age.ts"

/** Runs git in `cwd`, throwing with stderr on failure. Returns trimmed stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped" })
    .output()
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim()
  if (!out.success) throw new Error(`git ${args.join(" ")} failed: ${decode(out.stderr)}`)
  return decode(out.stdout)
}

/** A throwaway git repo with one commit — `worktree add` needs at least one. */
async function initRepoWithCommit(dir: string): Promise<void> {
  await git(dir, "init", "-q")
  await git(dir, "config", "user.email", "test@example.com")
  await git(dir, "config", "user.name", "test")
  await Deno.writeTextFile(join(dir, "README.md"), "x\n")
  await git(dir, "add", "README.md")
  await git(dir, "commit", "-q", "-m", "init")
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
  "resolveKeyFile: GIT_DIR pointing at a decoy repo never redirects resolution away from cwd's own repo (#226 review round)",
  async () => {
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
          assertEquals(resolveKeyFile(worktree), join(main, ".age", "key.txt"))
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

// End-to-end proof through the real encrypt/decrypt path: a worktree
// with no key of its own, GIT_DIR poisoned at a decoy repo, still
// encrypts for (and can only be decrypted by) the MAIN checkout's real
// key — never the decoy's.
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
      assertEquals(encryptResult.ok, true, encryptResult.output)

      // Decrypt the produced ciphertext directly with the MAIN
      // checkout's real identity key — this only succeeds if the value
      // was actually encrypted for that key, proving the decoy's public
      // key was never used as the recipient.
      const ageContent = await Deno.readTextFile(join(worktree, ".env.age"))
      const line = ageContent.split("\n").find((l) => l.startsWith("SECRET="))
      if (!line) throw new Error("SECRET line missing from .env.age")
      const ciphertextB64 = line.slice("SECRET=age64:".length)
      const decodeResult = await new Deno.Command("age", {
        args: ["-d", "-i", mainKey.path],
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn()
      const writer = decodeResult.stdin.getWriter()
      const { decodeBase64 } = await import("@std/encoding")
      await writer.write(decodeBase64(ciphertextB64))
      await writer.close()
      const decodeOutput = await decodeResult.output()
      assertEquals(
        decodeOutput.success,
        true,
        `expected the MAIN checkout's key to decrypt the ciphertext: ${
          new TextDecoder().decode(decodeOutput.stderr)
        }`,
      )
      assertEquals(new TextDecoder().decode(decodeOutput.stdout).trim(), "payload")
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  },
)
