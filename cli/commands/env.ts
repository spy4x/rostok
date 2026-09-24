// `rostok env encrypt|decrypt|status|setup` — explicit encryption commands.
//
// The wizard auto-runs encrypt after every `.env` write (see
// `cli/server-create.ts`/`cli/stack-add.ts`/`cli/stack-remove.ts`). These
// commands let users invoke the same logic directly — useful for
// backfilling `.env.age` after `rostok env setup`, or for decrypting
// `.env.age` into a fresh clone.
//
// `rostok env status` reports the encryption posture: is `.age/key.txt`
// present? How many `.env`/`.env.age` files exist?
//
// `rostok env setup` generates `.age/key.txt` for the user. rostok
// hides the underlying key generation — the user never has to know
// `age-keygen` exists.

import { Command } from "@cliffy/command"
import { relative } from "@std/path"
import {
  type AgeStatus,
  ageStatus,
  decryptEnvFiles,
  encryptEnvFiles,
  generateAgeKey,
  readAgeKey,
} from "@spy4x/server/env-age64"
import { ensureAgeIgnored } from "../init.ts"

/**
 * `ageStatus` walks the project for `.env`/`.env.age` files and can throw
 * (a symlinked env file, for instance — the module refuses to read
 * through one). Every command below needs a one-line error, not a raw
 * stack trace, so this wraps the call once instead of repeating the
 * try/catch at each call site.
 */
async function safeAgeStatus(cwd: string): Promise<AgeStatus> {
  try {
    return await ageStatus(cwd)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return Deno.exit(1)
  }
}

/** `rostok env encrypt` — run the encrypt task directly. */
export const envEncryptCommand = new Command()
  .description("Encrypt .env → .env.age (same as the auto-hook after wizard writes).")
  .action(async () => {
    const cwd = Deno.cwd()
    const status = await safeAgeStatus(cwd)
    if (!status.keyPresent) {
      console.error(
        "rostok env encrypt: .age/key.txt missing. run `rostok env setup` to generate one.",
      )
      Deno.exit(1)
    }
    try {
      await encryptEnvFiles(cwd)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      Deno.exit(1)
    }
  })

/** `rostok env decrypt` — inverse: age64 → plaintext. */
export const envDecryptCommand = new Command()
  .description("Decrypt .env.age → .env (run after a fresh git clone).")
  .action(async () => {
    const cwd = Deno.cwd()
    const status = await safeAgeStatus(cwd)
    if (!status.keyPresent) {
      console.error(
        "rostok env decrypt: .age/key.txt missing. can't decrypt without a key.",
      )
      Deno.exit(1)
    }
    try {
      await decryptEnvFiles(cwd)
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      Deno.exit(1)
    }
  })

/**
 * `rostok env status` — print the encryption posture. Exits 1 only when
 * the scan itself fails (a symlinked env file, say — see
 * {@link safeAgeStatus}); otherwise it always succeeds, whatever the
 * posture is, and shows the user what to do next.
 */
export const envStatusCommand = new Command()
  .description(
    "Show encryption posture (key present?, env files, age files).",
  )
  .action(async () => {
    const cwd = Deno.cwd()
    const status = await safeAgeStatus(cwd)
    const rel = (p: string) => relative(cwd, p) || p

    console.log(`.age/key.txt:       ${status.keyPresent ? "present" : "missing"}`)
    console.log(`.env files (${status.envFiles.length}):`)
    if (status.envFiles.length === 0) {
      console.log("  (none)")
    } else {
      for (const f of status.envFiles) console.log(`  ${rel(f)}`)
    }
    console.log(`.env.age files (${status.ageFiles.length}):`)
    if (status.ageFiles.length === 0) {
      console.log("  (none)")
    } else {
      for (const f of status.ageFiles) console.log(`  ${rel(f)}`)
    }

    // Friendly recommendation. Per Phase 5b UX feedback, we never expose
    // raw `age-keygen` commands — the CLI generates the key internally
    // when the user invokes `rostok env setup` (or accepts the prompt
    // during `rostok`).
    if (!status.keyPresent) {
      console.log("")
      console.log(
        "rostok: no encryption key. run `rostok env setup` to generate one.",
      )
    } else if (status.envFiles.length > status.ageFiles.length) {
      console.log("")
      console.log(
        "rostok: some .env files lack an .env.age sibling. run `rostok env encrypt` to backfill.",
      )
    } else if (status.envFiles.length === 0 && status.ageFiles.length === 0) {
      console.log("")
      console.log("rostok: no .env files in this project yet. run `rostok` to start the wizard.")
    }
  })

/** Outcome of {@link runEnvSetup} — separated from the `Command` so tests can call it without hitting `Deno.exit`. */
export interface EnvSetupResult {
  ok: boolean
  /** True when `.age/key.txt` already existed and nothing was generated. */
  alreadyExisted?: boolean
  /** Lines to print, in order (stdout when `ok`, stderr otherwise). */
  lines: string[]
}

/**
 * Core logic for `rostok env setup` — generate `.age/key.txt` for the
 * user. This is how the CLI hides key generation: the user never has to
 * invoke `age-keygen` themselves.
 *
 * Always runs {@link ensureAgeIgnored} before returning success, even
 * when a key already existed — a project created by 1.0.0–1.0.3 has a
 * key but never got the `.age/` gitignore rule, and `env setup` is the
 * one command such a user is likely to run again.
 */
export async function runEnvSetup(cwd: string): Promise<EnvSetupResult> {
  // #204: guarantee .age/key.txt can never be committed — before we
  // write a fresh key, and even when one already exists.
  const gitignoreFix = await ensureAgeIgnored(cwd)
  const status = await ageStatus(cwd)
  if (status.keyPresent) {
    // #236: print the path the key actually resolved to, not a
    // hardcoded `<cwd>/.age/key.txt` — in a linked worktree with no key
    // of its own, resolution falls back to the MAIN checkout's key, so
    // the old message named a path that didn't even have a file on it.
    const key = await readAgeKey(cwd)
    return {
      ok: true,
      alreadyExisted: true,
      lines: [
        `rostok env setup: .age/key.txt already exists at ${key.path}`,
        // Review fix: this run may still have changed .gitignore even
        // though the key itself is untouched — "no changes made" would
        // be false in that case.
        gitignoreFix.added ? "  key left unchanged." : "  no changes made.",
      ],
    }
  }
  let result: { path: string; recipient: string }
  try {
    result = await generateAgeKey(cwd)
  } catch (error) {
    return {
      ok: false,
      lines: [
        `rostok env setup: failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    }
  }
  return {
    ok: true,
    lines: [
      `rostok env setup: generated ${result.path}`,
      `  public key (safe to share): ${result.recipient}`,
      "  secret key in .age/key.txt — already gitignored.",
      "",
      "next: run `rostok env encrypt` to backfill any existing .env files.",
    ],
  }
}

/**
 * `rostok env setup` — thin CLI wrapper over {@link runEnvSetup}: prints
 * its lines and translates the result into an exit code.
 */
export const envSetupCommand = new Command()
  .description(
    "Generate the project's age encryption key (rostok hides key generation for you).",
  )
  .action(async () => {
    const result = await runEnvSetup(Deno.cwd())
    for (const line of result.lines) {
      if (result.ok) console.log(line)
      else console.error(line)
    }
    if (!result.ok) Deno.exit(1)
  })

/** `rostok env ...` — the group. */
export const envCommand = new Command()
  .description(
    `Manage .env encryption (age64). Auto-runs after every wizard write,
but you can also invoke manually for backfills and fresh clones.

Examples:

    rostok env status         # see whether a key is set up
    rostok env setup          # generate .age/key.txt (rostok hides key generation)
    rostok env encrypt        # backfill .env.age for any missing files
    rostok env decrypt        # run after a fresh git clone`,
  )
  .command("encrypt", envEncryptCommand)
  .command("decrypt", envDecryptCommand)
  .command("status", envStatusCommand)
  .command("setup", envSetupCommand)
