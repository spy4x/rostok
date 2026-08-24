// `rostok env encrypt|decrypt|status` — explicit encryption commands.
//
// The wizard auto-runs encrypt after every `.env` write (see
// `cli/encrypt.ts`). These commands let users invoke the same logic
// directly — useful for backfilling `.env.age` after installing `age`,
// or for decrypting `.env.age` into a fresh clone.
//
// `rostok env status` reports the encryption posture: is `age`
// installed? Is `.age/key.txt` present? How many `.env`/`.env.age`
// files exist?

import { Command } from "@cliffy/command"
import { relative } from "@std/path"
import { ageStatus, decryptEnvFiles, encryptEnvFiles } from "../encrypt.ts"

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
        "rostok env encrypt: .age/key.txt missing. run `age-keygen -o .age/key.txt` first.",
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

    // Friendly recommendation.
    if (!status.ageInstalled) {
      console.log("")
      console.log(
        "rostok recommends enabling age encryption so .env.age can be safely committed:",
      )
      console.log("  1. install age:  apt install age  (or: brew install age)")
      console.log("  2. generate key: age-keygen -o .age/key.txt")
      console.log("  3. backfill:     rostok env encrypt")
      console.log("  4. commit the encrypted .env.age, NOT .age/key.txt")
    } else if (!status.ageKeyPresent) {
      console.log("")
      console.log(
        "rostok: age is installed but no .age/key.txt. generate one to enable encryption:",
      )
      console.log("  age-keygen -o .age/key.txt")
      console.log("  rostok env encrypt")
    } else if (status.envFiles.length > status.ageFiles.length) {
      console.log("")
      console.log("rostok: some .env files lack an .env.age sibling. run `rostok env encrypt`.")
    } else if (status.envFiles.length === 0 && status.ageFiles.length === 0) {
      console.log("")
      console.log("rostok: no .env files in this project yet. run `rostok` to start the wizard.")
    }
  })

/** `rostok env ...` — the group. */
export const envCommand = new Command()
  .description(
    "Manage .env encryption (age64). " +
      "Auto-runs after every wizard write, but you can also invoke manually.",
  )
  .command("encrypt", envEncryptCommand)
  .command("decrypt", envDecryptCommand)
  .command("status", envStatusCommand)
