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
import { checkAgeInstalled, checkAgeKeyPresent, generateAgeKey } from "./encrypt.ts"
import { isCommandOnPath } from "./shell.ts"

const DENO_JSONC_TEMPLATE = `{
  "imports": {
    "@rostok/cli": "jsr:@rostok/cli@^1"
  }
}
`

const GITIGNORE_TEMPLATE = `# Plaintext secrets — never commit. The encrypted blobs (the
# *.age pair) are safe to commit; that's the whole point of encryption.
.env
.env.root

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
}

/**
 * Initialize the project skeleton in `cwd`. Idempotent.
 *
 * Phase 5 user feedback:
 * - No `.age/` directory or keypair placeholder. Encryption is
 *   optional; the user runs `age-keygen -o .age/key.txt` themselves
 *   if they want to encrypt.
 * - `.env.age` and `.env.root.age` are NOT gitignored — they're
 *   encrypted blobs, safe to commit.
 * - `.env.root` is created empty; user populates with cross-server
 *   creds (BACKUPS_PASSWORD, BACKUP_PATHS, CLOUDFLARE_API_TOKEN)
 *   manually or in a later edit.
 *
 *   Note: `.env.root.age` is NOT created by init. When the user adds
 *   age64 encryption (via `age-keygen -o .age/key.txt` + manual edits),
 *   `deno task env:encrypt` produces both `.env.age` and
 *   `.env.root.age` (per scripts/encryption/encrypt.ts logic).
 */
export async function initProject(cwd: string = Deno.cwd()): Promise<InitResult> {
  const created: string[] = []
  const skipped: string[] = []

  // 1. deno.jsonc
  await writeIfMissing(join(cwd, "deno.jsonc"), DENO_JSONC_TEMPLATE, created, skipped)

  // 2. .gitignore (plaintext secrets only)
  await writeIfMissing(join(cwd, ".gitignore"), GITIGNORE_TEMPLATE, created, skipped)

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

  // 6. age endorsement — best effort, interactive prompt only on first init.
  //
  // Encryption is OPTIONAL but the CLI actively recommends it: .env.age
  // is safe to commit, .env is not. After init:
  // - age missing → info-level tip + return
  // - age present, key missing → ASK the user if they want rostok to
  //   generate the keypair for them (rostok runs age-keygen, hides the
  //   raw command from the user)
  // - key present → silent
  //
  // Skipped on idempotent calls (created.length === 0) so the prompt
  // doesn't repeat on every wizard run.
  if (created.length > 0) {
    await maybeOfferKeyGeneration(cwd)
  }

  return { created, skipped, gitInitialized }
}

/**
 * Endorse age encryption after init. Per Phase 5b UX feedback, we never
 * show the user a raw `age-keygen` command — when a key is missing, we
 * OFFER to generate it for them. Non-interactive calls skip the prompt
 * entirely (the user explicitly opted out of prompts by passing -n).
 */
async function maybeOfferKeyGeneration(cwd: string): Promise<void> {
  const ageInstalled = await checkAgeInstalled()
  if (!ageInstalled) {
    console.info(
      "rostok: install `age` (e.g. `apt install age`) to encrypt .env.age for git. " +
        "`rostok` will detect it on the next run and offer to set up encryption.",
    )
    return
  }
  if (await checkAgeKeyPresent(cwd)) return // already set up — silent
  // Skip the prompt entirely when stdin isn't a TTY (CI, test runners,
  // non-interactive mode). Confirm.prompt redraws forever in non-TTY
  // mode, so we check upfront rather than catching a hang.
  if (!Deno.stdin.isTerminal()) return
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
  const result = await generateAgeKey(cwd)
  if (result.ok) {
    console.info(
      `rostok: generated ${result.path}. public key: ${result.publicKey}\n` +
        "  (the public key is safe to share; the secret key in .age/key.txt is NOT — gitignore'd automatically.)",
    )
  } else {
    console.warn(`rostok: failed to generate key: ${result.error}`)
  }
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
