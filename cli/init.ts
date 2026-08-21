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

const GITIGNORE_TEMPLATE = `# secrets + runtime state — never commit
.env
.env.age
.env.root
.env.root.age
.age/

# deno
deno.lock
`

// Age key directory + placeholder file. The encrypt flow expects
// .age/key.txt to exist (CLI-managed key lives there). Creating an
// empty placeholder lets `initProject` succeed without a real age key —
// the user runs `age-keygen -o .age/key.txt` (or our future setup flow)
// before the first encrypt.
const AGE_KEY_PLACEHOLDER = `# Placeholder — replace with your age keypair.
# Generate one with:  age-keygen -o .age/key.txt
# (See docs/v1-cli.md §6 for the full encryption flow.)
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
 * @param cwd Directory to initialize. Defaults to process CWD.
 */
export async function initProject(cwd: string = Deno.cwd()): Promise<InitResult> {
  const created: string[] = []
  const skipped: string[] = []

  // 1. deno.jsonc
  await writeIfMissing(join(cwd, "deno.jsonc"), DENO_JSONC_TEMPLATE, created, skipped)

  // 2. .gitignore
  await writeIfMissing(join(cwd, ".gitignore"), GITIGNORE_TEMPLATE, created, skipped)

  // 3. servers/ — empty dir
  await mkdirIfMissing(join(cwd, "servers"), created, skipped)

  // 4. .age/ — key directory (placeholder for first encrypt)
  await mkdirIfMissing(join(cwd, ".age"), created, skipped)
  await writeIfMissing(join(cwd, ".age", "key.txt"), AGE_KEY_PLACEHOLDER, created, skipped)

  // 5. .env.root — empty file (server-create populates it)
  await writeIfMissing(join(cwd, ".env.root"), "", created, skipped)

  // 6. git init — best effort, do not fail the wizard
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
