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

  return { created, skipped, gitInitialized }
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
  try {
    const cmd = new Deno.Command("git", { args: ["init"], cwd, stdout: "null", stderr: "null" })
    const out = await cmd.output()
    if (out.success) return true
  } catch {
    // git not on PATH — fall through to info message below.
  }
  console.info(
    "rostok: git not found on PATH. skipped `git init`. re-run after installing git if you want version control.",
  )
  return false
}
