// age64 — per-value encryption with age.
//
// `KEY=age64:<base64-encoded-age-ciphertext>` format. Each value encrypted
// independently so unchanged values keep their original ciphertext
// byte-for-byte (zero diff noise in git).
//
// Key file: `<cwd>/.age/key.txt` (the user's project root).
//
// This module lives in cli/ because the CLI inlines encryption at the
// point of write (per docs/v1-cli.md §6, every `.env` mutation triggers
// re-encryption). scripts/encryption/* re-exports it for the standalone
// `deno task env:encrypt` workflow (rostok repo devs).
//
// Originally copied from scripts/encryption/age-lib.ts to make the CLI
// self-contained for JSR publishing — the previous shell-out to
// `deno task env:encrypt` failed when the user's project didn't define
// that task.

import { dirname, join } from "@std/path"
import { decodeBase64, encodeBase64 } from "@std/encoding"

const AGE64_PREFIX = "age64:"

/**
 * Env vars a PARENT process (a pre-commit hook running its own git
 * commands, for instance) may have exported to steer ITS git invocation
 * at a specific repo. `git` honours these regardless of `cwd`, so
 * inheriting them here would silently resolve the key file against
 * whatever repo the parent process meant, not `cwd`.
 */
const GIT_ENV_POISON = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]

/**
 * True when any git-poisoning env var is set. Checked by NAME
 * (`Deno.env.get` per key), never `Deno.env.toObject()` — the latter
 * needs the broad, unscoped `--allow-env` grant (read every variable in
 * the process's environment), where this only needs a SCOPED
 * `--allow-env=GIT_DIR,GIT_COMMON_DIR,GIT_WORK_TREE,GIT_INDEX_FILE`
 * (four names, nothing else). `deno task env:encrypt`/`env:decrypt`
 * grant neither today (see deno.jsonc) — calling this without either
 * throws `Deno.errors.NotCapable`, which `resolveKeyFile` below lets
 * surface rather than swallowing (a real permission problem must fail
 * loudly, not silently fall back to "no key found").
 */
function anyGitEnvPoisoned(): boolean {
  for (const key of GIT_ENV_POISON) {
    if (Deno.env.get(key) !== undefined) return true
  }
  return false
}

/**
 * Resolve `.age/key.txt` for `cwd` — never `Deno.cwd()`, so a caller
 * always controls exactly which project's key this resolves to.
 *
 * 1. `<cwd>/.age/key.txt` wins outright when it exists — the common
 *    case, and the only one that needs no git subprocess (or any env
 *    permission) at all. A linked worktree that has run
 *    `env-key-copy.ts` (AGENTS.md's worktree setup step) has its own
 *    copy here.
 * 2. Otherwise, ask git for the checkout's shared `.git`
 *    (`--git-common-dir`), which for a linked worktree lives in the
 *    MAIN checkout — so a worktree that hasn't copied its own key yet
 *    still finds the main checkout's. Runs with `cwd` passed as the
 *    subprocess's own working directory (not inherited from
 *    `Deno.cwd()`). Skipped entirely — falling straight through to
 *    step 3 — when any of the git-poisoning env vars above is set:
 *    there is no way to ask git to ignore its own `GIT_DIR` etc.
 *    without clearing (and therefore fully reconstructing) the child's
 *    whole environment, which would need the broad `--allow-env` this
 *    function is deliberately avoiding — refusing to trust git's
 *    answer here is the safe choice, not silently trusting a possibly
 *    redirected one.
 * 3. Falls back to `<cwd>/.age/key.txt` (same path as step 1) when git
 *    isn't on PATH, `cwd` isn't inside a repository, or step 2 was
 *    skipped for poisoning.
 */
export function resolveKeyFile(cwd: string): string {
  const local = join(cwd, ".age", "key.txt")
  try {
    if (Deno.statSync(local).isFile) return local
  } catch { /* no local key — fall through to git */ }

  if (!anyGitEnvPoisoned()) {
    try {
      const cmd = new Deno.Command("git", {
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd,
        stdout: "piped",
        stderr: "piped",
      })
      const out = cmd.outputSync()
      if (out.code === 0) {
        const gitDir = new TextDecoder().decode(out.stdout).trim()
        if (gitDir) return join(dirname(gitDir), ".age", "key.txt")
      }
    } catch (err) {
      // Only a missing `git` binary falls through silently — anything
      // else (a permission error, for instance) is a real problem the
      // caller must see, not a reason to quietly report "no key".
      if (!(err instanceof Deno.errors.NotFound)) throw err
    }
  }
  return local
}

// Cached per cwd (not process-global): a CLI invocation may legitimately
// touch more than one project root (tests do), and each must resolve
// its own key independently. Cleared implicitly at process exit.
const _keyFileByCwd = new Map<string, string>()
function getAgeKeyFile(cwd: string): string {
  let cached = _keyFileByCwd.get(cwd)
  if (cached === undefined) {
    cached = resolveKeyFile(cwd)
    _keyFileByCwd.set(cwd, cached)
  }
  return cached
}

export interface EnvEntry {
  /** Original line, preserves comments and blanks verbatim. */
  raw: string
  /** Env var key (undefined for comment/blank/malformed lines). */
  key?: string
  /** Plaintext value (undefined when line is age64-encrypted). */
  value?: string
  /** age64 ciphertext (undefined when line is plaintext). */
  encrypted?: string
}

/**
 * Read the recipient (public key) from `cwd`'s `.age/key.txt` (see
 * `resolveKeyFile` for how `cwd` resolves to a file). Throws if the
 * file is missing or the comment isn't present.
 */
export function getAgePublicKey(cwd: string): string {
  const keyFile = getAgeKeyFile(cwd)
  const content = Deno.readTextFileSync(keyFile)
  const match = content.match(/# public key: (.+)/)
  if (!match) throw new Error(`age public key not found in ${keyFile}`)
  return match[1].trim()
}

/**
 * True if `age` CLI is on PATH. Used to gate encryption operations.
 */
export async function checkAgeInstalled(): Promise<boolean> {
  try {
    const out = await new Deno.Command("age", { args: ["--version"] }).output()
    return out.success
  } catch {
    return false
  }
}

/**
 * Encrypt a plaintext value with age; return `age64:<base64>` form.
 * `cwd` picks which project's key to encrypt for (see `resolveKeyFile`)
 * — ignored when `recipient` is given explicitly.
 */
export async function ageEncrypt(value: string, cwd: string, recipient?: string): Promise<string> {
  if (!recipient) recipient = getAgePublicKey(cwd)
  const cmd = new Deno.Command("age", {
    args: ["-r", recipient, "-o", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  })
  const proc = cmd.spawn()
  const writer = proc.stdin.getWriter()
  await writer.write(new TextEncoder().encode(value))
  await writer.close()
  const output = await proc.output()
  if (!output.success) {
    throw new Error("age encrypt failed: " + new TextDecoder().decode(output.stderr))
  }
  return AGE64_PREFIX + encodeBase64(new Uint8Array(output.stdout))
}

/**
 * Decrypt an `age64:<base64>` value back to plaintext. `cwd` picks
 * which project's key to decrypt with (see `resolveKeyFile`) — defaults
 * to `Deno.cwd()` for callers outside the CLI itself (e.g.
 * scripts/backup, which always runs from the repo root) that haven't
 * threaded an explicit cwd through yet.
 */
export async function ageDecrypt(age64Value: string, cwd: string = Deno.cwd()): Promise<string> {
  if (!age64Value.startsWith(AGE64_PREFIX)) {
    throw new Error("Not an age64 value: " + age64Value.slice(0, 20))
  }
  const ciphertext = decodeBase64(age64Value.slice(AGE64_PREFIX.length))
  const cmd = new Deno.Command("age", {
    args: ["-d", "-i", getAgeKeyFile(cwd), "-o", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  })
  const proc = cmd.spawn()
  const writer = proc.stdin.getWriter()
  await writer.write(ciphertext)
  await writer.close()
  const output = await proc.output()
  if (!output.success) {
    throw new Error("age decrypt failed: " + new TextDecoder().decode(output.stderr))
  }
  return new TextDecoder().decode(output.stdout).trim()
}

/** True when `value` is an `age64:...` ciphertext (vs plaintext). */
export function isAge64(value: string): boolean {
  return value.startsWith(AGE64_PREFIX)
}

/**
 * Parse an env file into raw + structured entries. Comments and blanks
 * are preserved verbatim via `raw`; lines with `KEY=age64:...` get
 * `encrypted` set; other `KEY=val` lines get `value` set.
 *
 * `value` is the text after `=`, verbatim — including any surrounding
 * quotes (#226: this used to strip one matched layer of `'...'`/`"..."`
 * and never restore it on write, so `KEY="has a space"` came back as
 * `KEY=has a space` after an encrypt+decrypt round trip). Matches
 * cli/env-files.ts's own convention: this is about the FILE round trip
 * — a `.env`/`.env.age` byte for byte — not what a container or a hook
 * ends up seeing. docker compose's `env_file` and Deno's `--env-file`
 * strip exactly one matching layer of quotes when they actually load
 * the file — but they also do more than that: both turn `\n` inside
 * double quotes into a real newline and drop a trailing ` # comment`
 * from an unquoted value (verified directly). `cli/deploy/hooks.ts`'s
 * `buildHookEnv` only does the one-quote-layer strip (`stripOneQuoteLayer`
 * — see its own comment), not the escape/comment handling, so a hook can
 * see a different value than its container for those two forms. This
 * function's `value` deliberately keeps the quotes so the file itself
 * never loses them.
 */
export function parseEnvFile(content: string): EnvEntry[] {
  const entries: EnvEntry[] = []
  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      entries.push({ raw: line })
      continue
    }
    const eqIdx = line.indexOf("=")
    if (eqIdx === -1) {
      entries.push({ raw: line })
      continue
    }
    const key = line.slice(0, eqIdx).trim()
    const value = line.slice(eqIdx + 1)
    const encrypted = isAge64(value) ? value : undefined
    entries.push({ raw: line, key, value, encrypted })
  }
  return entries
}

/** True if `dir` has its own .git checkout (worktree, submodule, clone). */
async function isNestedCheckout(dir: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(join(dir, ".git"))
    return stat.isDirectory || stat.isFile
  } catch {
    return false
  }
}

/**
 * Walk `rootDir` for `.env` files (top-level + subdirs, skipping hidden
 * dirs and nested checkouts). Matches the existing findEnvFiles from
 * scripts/encryption/age-lib.ts.
 */
export async function findEnvFiles(rootDir: string = Deno.cwd()): Promise<string[]> {
  const results: string[] = []
  await walkEnvDir(rootDir, results, /^\.env/)
  return results.sort()
}

async function walkEnvDir(
  dir: string,
  results: string[],
  nameFilter: RegExp,
): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      if (await isNestedCheckout(path)) continue
      await walkEnvDir(path, results, nameFilter)
      continue
    }
    if (
      nameFilter.test(entry.name) &&
      !entry.name.includes(".example") &&
      !entry.name.includes(".sops-backup") &&
      !entry.name.endsWith(".age")
    ) {
      results.push(path)
    }
  }
}

/** Walk `rootDir` for `.env*.age` files (matching the env naming pattern). */
export async function findAgeFiles(rootDir: string = Deno.cwd()): Promise<string[]> {
  const results: string[] = []
  for await (const entry of Deno.readDir(rootDir)) {
    const path = join(rootDir, entry.name)
    if (entry.isDirectory) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      if (await isNestedCheckout(path)) continue
      await walkAgeDir(path, results)
      continue
    }
    if (isEnvAgeFile(entry.name)) results.push(path)
  }
  return results.sort()
}

async function walkAgeDir(dir: string, results: string[]): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name)
    if (entry.isDirectory) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      if (await isNestedCheckout(path)) continue
      await walkAgeDir(path, results)
      continue
    }
    if (isEnvAgeFile(entry.name)) results.push(path)
  }
}

/** True if `name` is an env-naming `.age` file (e.g. `.env.age`, `.env.prod.age`). */
function isEnvAgeFile(name: string): boolean {
  if (!name.endsWith(".age")) return false
  if (name.endsWith(".sops-backup.age")) return false
  if (name.includes(".example")) return false
  return name.includes(".env")
}

/** Map an env file to its .age sibling (just appends `.age`). */
export function getEnvAgePath(envPath: string): string {
  return envPath + ".age"
}
