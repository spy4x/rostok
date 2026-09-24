// Project skeleton init.
//
// Per docs/v1-cli.md §3.1 step 1, `$ rostok` in an empty folder creates:
//
//   .
//   ├── deno.jsonc            # imports map for @rostok/cli, tasks
//   ├── .gitignore            # secrets, runtime state
//   ├── .git/                 # git init if missing and git is installed
//   ├── servers/              # empty dir
//   ├── .env.root             # CLI-managed root env (gitignored)
//   └── .env.root.age         # encrypted (gitignored)
//
// Idempotent: existing files are left alone (warn). This matches the
// design §3.1 behavior — "If any file already exists → warn, leave it alone."

import { exists } from "@std/fs"
import { join } from "@std/path"
import { Confirm } from "@cliffy/prompt"
import { ageStatus, generateAgeKey } from "@spy4x/server/env-age64"
import { isCommandOnPath } from "./shell.ts"
import { assertInteractiveStdin } from "./prompts.ts"

const DENO_JSONC_TEMPLATE = `{
  "imports": {
    "@rostok/cli": "jsr:@rostok/cli/lib"
  }
}
`

const GITIGNORE_TEMPLATE = `# Plaintext secrets — never commit. The encrypted blobs (the
# *.age pair) are safe to commit; that's the whole point of encryption.
.env
.env.root

# age encryption private key — decrypts every encrypted env file in
# this project. NEVER commit this.
.age/

# @spy4x/server/env-age64's atomic-write leftover, if a crash ever left
# one behind (same directory as the plaintext or encrypted file it was
# writing).
.age64-tmp-*

# deno runtime
deno.lock
`

export interface InitResult {
  /** Files actually written by this invocation. */
  created: string[]
  /** Files that already existed (skipped). */
  skipped: string[]
  /** Whether `git init` ran successfully (false if git not on PATH). */
  gitInitialized: boolean
  /**
   * True when this was a first-time init (created something) — the
   * caller should offer key generation via {@link maybeOfferKeyGeneration}
   * once it's done printing what was created. #212: the old code ran the
   * "generate a key?" prompt from inside `initProject` itself, before the
   * caller had printed the "Initialized: …" file list — a first-timer
   * answered a prompt with no idea yet what had just happened.
   */
  shouldOfferKeyGeneration: boolean
}

/**
 * Initialize the project skeleton in `cwd`. Idempotent.
 *
 * Phase 5 user feedback:
 * - No `.age/` directory or keypair placeholder. Encryption is
 *   optional; the user runs `rostok env setup` themselves if they want
 *   to encrypt (or accepts the prompt this init step offers).
 * - `.env.age` and `.env.root.age` are NOT gitignored — they're
 *   encrypted blobs, safe to commit.
 * - `.env.root` is created empty; user populates with cross-server
 *   creds (BACKUPS_PASSWORD, BACKUP_PATHS, CLOUDFLARE_API_TOKEN)
 *   manually or in a later edit.
 *
 *   Note: `.env.root.age` is NOT created by init. When the user adds
 *   age64 encryption (via `rostok env setup` + manual edits),
 *   `deno task env:encrypt` produces both `.env.age` and
 *   `.env.root.age` (`@spy4x/server/env-age64`).
 */
export async function initProject(cwd: string = Deno.cwd()): Promise<InitResult> {
  const created: string[] = []
  const skipped: string[] = []

  // 1. deno.jsonc
  await writeIfMissing(join(cwd, "deno.jsonc"), DENO_JSONC_TEMPLATE, created, skipped)

  // 2. .gitignore (plaintext secrets only)
  await writeIfMissing(join(cwd, ".gitignore"), GITIGNORE_TEMPLATE, created, skipped)

  // 2b. #204: guarantee .age/key.txt can never be committed, on every
  // run — not just the first. Projects created by 1.0.0–1.0.3 shipped a
  // .gitignore without this rule; this backfills it.
  await ensureAgeIgnored(cwd)

  // 3. servers/ — empty dir for per-server config
  await mkdirIfMissing(join(cwd, "servers"), created, skipped)

  // 4. .env.root — empty file (cross-server creds, user populates manually)
  await writeIfMissing(join(cwd, ".env.root"), "", created, skipped)

  // 5. git init — best effort, do not fail the wizard
  let gitInitialized = false
  if (!(await exists(join(cwd, ".git")))) {
    gitInitialized = await tryGitInit(cwd)
  } else {
    gitInitialized = true // already initialized
  }

  // 6. age endorsement — best effort, interactive prompt only on first
  // init. #212: the caller runs this (via maybeOfferKeyGeneration) only
  // after it has printed the "Initialized: …" file list — see
  // shouldOfferKeyGeneration's doc comment. Skipped on idempotent calls
  // (created.length === 0) so the prompt doesn't repeat on every run.
  return { created, skipped, gitInitialized, shouldOfferKeyGeneration: created.length > 0 }
}

/**
 * Endorse age encryption after init. Per Phase 5b UX feedback, we never
 * show the user a raw `age-keygen` command — when a key is missing, we
 * OFFER to generate it for them. Non-interactive calls skip the prompt
 * entirely (the user explicitly opted out of prompts by passing -n).
 *
 * Encryption runs in-process (`@spy4x/server/env-age64`), so there is no
 * `age` binary to check for any more — only whether a key already
 * exists.
 *
 * #212: called by the wizard only when `InitResult.shouldOfferKeyGeneration`
 * is true, and only after it has already printed the "Initialized: …"
 * file list — so the prompt has context instead of appearing first.
 */
export async function maybeOfferKeyGeneration(cwd: string): Promise<void> {
  let status
  try {
    status = await ageStatus(cwd)
  } catch (error) {
    console.warn(`rostok: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (status.keyPresent) return // already set up — silent
  // #235: fail loudly (one shared guard, prompts.ts) instead of
  // Confirm.prompt's own behavior of redrawing forever against a non-TTY
  // stdin. This offer only runs when the caller already decided the run
  // is interactive (opts.nonInteractive is false) — a non-TTY stdin here
  // means the caller forgot `-n`, same as any other prompt in the CLI.
  assertInteractiveStdin()
  const answer = await Confirm.prompt({
    message: "no encryption key found. generate one now? (so .env.age can be committed)",
    default: true,
  })
  if (!answer) {
    console.info(
      "rostok: skipped key generation. run `rostok env setup` later to enable encryption.",
    )
    return
  }
  try {
    const result = await generateAgeKey(cwd)
    console.info(
      `rostok: generated ${result.path}. public key: ${result.recipient}\n` +
        "  (the public key is safe to share; the secret key in .age/key.txt is NOT — " +
        "rostok keeps .age/ gitignored, see above.)",
    )
  } catch (error) {
    console.warn(
      `rostok: failed to generate key: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * #204: make sure `.age/key.txt` can never be committed. Prefers `git
 * check-ignore` (handles nested/negated patterns correctly) when git and
 * a repo are available; otherwise falls back to a plain-text scan of
 * `.gitignore` for a rule that would cover it. Appends `.age/` and
 * prints a one-line notice when neither already covers it.
 *
 * Security review: a gitignore rule does nothing for a key that's
 * already tracked (staged or committed) — the secret is already in the
 * repository, possibly its history, whether or not future `git add`
 * would pick it up again. When that's the case, warn instead of
 * silently making the project merely *look* fixed.
 *
 * Exported so `rostok env setup` (cli/commands/env.ts) can run the same
 * check right before it writes a key, not just during init/wizard runs.
 */
export async function ensureAgeIgnored(
  cwd: string,
): Promise<{ added: boolean; tracked?: boolean }> {
  const tracked = await isAgeKeyTracked(cwd)
  if (tracked) {
    console.warn(
      "rostok: .age/key.txt is already tracked by git — anyone with this repository (or its " +
        "history) can already decrypt every .env.age. Run `git rm --cached .age/key.txt`, " +
        "commit that removal, then delete .age/key.txt and run `rostok env setup` again to " +
        "rotate the key. Adding a gitignore rule alone does not undo this.",
    )
  }
  if (await isAgeIgnored(cwd)) return { added: false, tracked }
  await appendGitignoreRule(cwd, ".age/")
  console.info(
    "rostok: .age/key.txt wasn't gitignored — added `.age/` to .gitignore. " +
      "the encryption key must never be committed.",
  )
  return { added: true, tracked }
}

/** True when `.age/key.txt` is staged or committed in git — a gitignore rule can't undo that. */
async function isAgeKeyTracked(cwd: string): Promise<boolean> {
  if (!(await exists(join(cwd, ".git"))) || !(await isCommandOnPath("git"))) return false
  try {
    const cmd = new Deno.Command("git", {
      args: ["ls-files", "--error-unmatch", ".age/key.txt"],
      cwd,
      stdout: "null",
      stderr: "null",
    })
    return (await cmd.output()).success
  } catch {
    return false
  }
}

async function isAgeIgnored(cwd: string): Promise<boolean> {
  if (await exists(join(cwd, ".git")) && await isCommandOnPath("git")) {
    try {
      const cmd = new Deno.Command("git", {
        args: ["check-ignore", "-q", ".age/key.txt"],
        cwd,
        stdout: "null",
        stderr: "null",
      })
      const out = await cmd.output()
      return out.success
    } catch {
      // git crashed mid-run — fall through to the text check below.
    }
  }
  return await gitignoreTextCoversAge(cwd)
}

/** Best-effort match — not a full gitignore glob parser, just the common rule shapes. */
async function gitignoreTextCoversAge(cwd: string): Promise<boolean> {
  let text: string
  try {
    text = await Deno.readTextFile(join(cwd, ".gitignore"))
  } catch {
    return false
  }
  const candidates = new Set([".age", ".age/", "/.age", "/.age/", ".age/*", ".age/key.txt"])
  return text.split("\n").some((line) => candidates.has(line.trim()))
}

async function appendGitignoreRule(cwd: string, rule: string): Promise<void> {
  const path = join(cwd, ".gitignore")
  let text = ""
  try {
    text = await Deno.readTextFile(path)
  } catch {
    // No .gitignore yet — unlikely (init always writes one first), but
    // handle gracefully: start a fresh file with just this rule.
  }
  const sep = text.length > 0 && !text.endsWith("\n") ? "\n" : ""
  await Deno.writeTextFile(path, `${text}${sep}${rule}\n`)
}

async function writeIfMissing(
  path: string,
  content: string,
  created: string[],
  skipped: string[],
): Promise<void> {
  if (await exists(path)) {
    skipped.push(path)
    return
  }
  await Deno.writeTextFile(path, content)
  created.push(path)
}

async function mkdirIfMissing(
  path: string,
  created: string[],
  skipped: string[],
): Promise<void> {
  // Deno.mkdir({ recursive: true }) succeeds silently if the dir already
  // exists, so we check explicitly to keep `created` accurate.
  if (await exists(path)) {
    skipped.push(path)
    return
  }
  await Deno.mkdir(path, { recursive: true })
  created.push(path)
}

async function tryGitInit(cwd: string): Promise<boolean> {
  if (!(await isCommandOnPath("git"))) {
    console.info(
      "rostok: git not found on PATH. skipped `git init`. re-run after installing git if you want version control.",
    )
    return false
  }
  try {
    const cmd = new Deno.Command("git", { args: ["init"], cwd, stdout: "null", stderr: "null" })
    const out = await cmd.output()
    if (out.success) return true
  } catch {
    // git crashed mid-run — fall through to info message below.
  }
  console.info(
    "rostok: `git init` failed. re-run after fixing git if you want version control.",
  )
  return false
}
