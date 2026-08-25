/**
 * age64 — re-export shim.
 *
 * The age64 logic lives in `cli/age.ts` (single source of truth). This
 * file re-exports it for the rostok repo's standalone `deno task
 * env:encrypt` workflow — repo devs who run encryption from the repo
 * itself without invoking the CLI.
 *
 * JSR-published users get the bundled cli/age.ts via the CLI binary;
 * they never touch this file.
 */

export {
  ageDecrypt,
  ageEncrypt,
  checkAgeInstalled,
  type EnvEntry,
  findAgeFiles,
  findEnvFiles,
  getAgePublicKey,
  getEnvAgePath,
  isAge64,
  parseEnvFile,
} from "../../cli/age.ts"
