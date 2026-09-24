// `rostok env encrypt|decrypt|status|setup` — explicit encryption commands.
//
// The wizard auto-runs encrypt after every `.env` write (see
// `cli/encrypt.ts`). These commands let users invoke the same logic
// directly — useful for backfilling `.env.age` after installing `age`,
// or for decrypting `.env.age` into a fresh clone.
//
// `rostok env status` reports the encryption posture: is `age`
// installed? Is `.age/key.txt` present? How many `.env`/`.env.age`
// files exist?
//
// `rostok env setup` generates `.age/key.txt` for the user. rostok
// hides the underlying `age-keygen` invocation — the user never has to
// know that command exists.

import { Command } from "@cliffy/command"
import { relative } from "@std/path"
import {
  ageStatus,
  checkAgeInstalled,
  checkAgeKeyPresent,
  decryptEnvFiles,
  encryptEnvFiles,
  generateAgeKey,
} from "../encrypt.ts"
import { resolveKeyFile } from "../age.ts"
import { ensureAgeIgnored } from "../init.ts"

/** `rostok env encrypt` — run the encrypt task directly. */
export const envEncryptCommand = new Command()
  .description("Encrypt .env → .env.age (same as the auto-hook after wizard writes).")
  .action(async () => {
    const cwd = Deno.cwd()
    const status = await ageStatus(cwd)
    if (!status.ageInstalled) {
      console.error(
        "rostok env encrypt: age not installed. install with `apt install age`.",
      )
      Deno.exit(1)
    }
    if (!status.ageKeyPresent) {
      console.error(
        "rostok env encrypt: .age/key.txt missing. run `rostok env setup` to generate one.",
      )
      Deno.exit(1)
    }
    const result = await encryptEnvFiles(cwd)
    if (!result.ok && !result.skipped) {
      Deno.exit(1)
    }
  })

/** `rostok env decrypt` — inverse: age64 → plaintext. */
export const envDecryptCommand = new Command()
  .description("Decrypt .env.age → .env (run after a fresh git clone).")
  .action(async () => {
    const cwd = Deno.cwd()
    const status = await ageStatus(cwd)
    if (!status.ageInstalled) {
      console.error(
        "rostok env decrypt: age not installed. install with `apt install age`.",
      )
      Deno.exit(1)
    }
    if (!status.ageKeyPresent) {
      console.error(
        "rostok env decrypt: .age/key.txt missing. can't decrypt without a key.",
      )
      Deno.exit(1)
    }
    const result = await decryptEnvFiles(cwd)
    if (!result.ok && !result.skipped) {
      Deno.exit(1)
    }
  })

/**
 * `rostok env status` — print the encryption posture. Always exits 0 —
 * status queries never fail. Shows the user what they need to do to
 * enable encryption.
 */
export const envStatusCommand = new Command()
  .description(
    "Show encryption posture (age installed?, key present?, env files, age files).",
  )
  .action(async () => {
    const cwd = Deno.cwd()
    const status = await ageStatus(cwd)
    const rel = (p: string) => relative(cwd, p) || p

    console.log(`age installed:      ${status.ageInstalled ? "yes" : "NO"}`)
    console.log(`.age/key.txt:       ${status.ageKeyPresent ? "present" : "missing"}`)
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
    // raw `age-keygen` commands — the CLI runs age-keygen internally
    // when the user invokes `rostok env setup` (or accepts the prompt
    // during `rostok`).
    if (!status.ageInstalled) {
      console.log("")
      console.log(
        "rostok: install `age` (e.g. `apt install age`) and re-run `rostok` — " +
          "it will offer to set up encryption for you.",
      )
    } else if (!status.ageKeyPresent) {
      console.log("")
      console.log(
        "rostok: age is installed but no encryption key. " +
          "run `rostok env setup` to generate one.",
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
 * user. This is how the CLI hides `age-keygen`: the user never has to
 * invoke that command themselves. Run after installing `age` to enable
 * encryption.
 *
 * Always runs {@link ensureAgeIgnored} before returning success, even
 * when a key already existed — a project created by 1.0.0–1.0.3 has a
 * key but never got the `.age/` gitignore rule, and `env setup` is the
 * one command such a user is likely to run again.
 */
export async function runEnvSetup(cwd: string): Promise<EnvSetupResult> {
  if (!(await checkAgeInstalled())) {
    return {
      ok: false,
      lines: ["rostok env setup: age not installed. install with `apt install age` and retry."],
    }
  }
  // #204: guarantee .age/key.txt can never be committed — before we
  // write a fresh key, and even when one already exists.
  const gitignoreFix = await ensureAgeIgnored(cwd)
  if (await checkAgeKeyPresent(cwd)) {
    // #236: print the path `checkAgeKeyPresent` (via `resolveKeyFile`)
    // actually found, not a hardcoded `<cwd>/.age/key.txt` — in a linked
    // worktree with no key of its own, resolution falls back to the MAIN
    // checkout's key, so the old message named a path that didn't even
    // have a file on it.
    return {
      ok: true,
      alreadyExisted: true,
      lines: [
        `rostok env setup: .age/key.txt already exists at ${resolveKeyFile(cwd)}`,
        // Review fix: this run may still have changed .gitignore even
        // though the key itself is untouched — "no changes made" would
        // be false in that case.
        gitignoreFix.added ? "  key left unchanged." : "  no changes made.",
      ],
    }
  }
  const result = await generateAgeKey(cwd)
  if (!result.ok) {
    return { ok: false, lines: [`rostok env setup: failed: ${result.error}`] }
  }
  const lines = [`rostok env setup: generated ${result.path}`]
  if (result.publicKey) {
    lines.push(`  public key (safe to share): ${result.publicKey}`)
    lines.push("  secret key in .age/key.txt — already gitignored.")
  }
  lines.push("")
  lines.push("next: run `rostok env encrypt` to backfill any existing .env files.")
  return { ok: true, lines }
}

/**
 * `rostok env setup` — thin CLI wrapper over {@link runEnvSetup}: prints
 * its lines and translates the result into an exit code.
 */
export const envSetupCommand = new Command()
  .description(
    "Generate the project's age encryption key (rostok hides age-keygen for you).",
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

    rostok env status         # see whether age + key are set up
    rostok env setup          # generate .age/key.txt (rostok runs age-keygen)
    rostok env encrypt        # backfill .env.age for any missing files
    rostok env decrypt        # run after a fresh git clone`,
  )
  .command("encrypt", envEncryptCommand)
  .command("decrypt", envDecryptCommand)
  .command("status", envStatusCommand)
  .command("setup", envSetupCommand)
