import { parseArgs } from "@std/cli/parse-args"

export type VerifyChoice = "fast" | "full" | "skip"
export type SmartChoice = "short" | "long" | "skip"

/** Answers taken from the command line instead of `prompt()`. */
export interface Options {
  /** False with `--yes` or when stdin is no terminal: nothing is asked. */
  interactive: boolean
  drive?: string
  verify?: VerifyChoice
  smart?: SmartChoice
  useMounted: boolean
  deleteMissing: boolean
  overwriteLocal: boolean
}

/** A wrong flag or a missing answer in a non-interactive run. Exits 2. */
export class UsageError extends Error {
  override name = "UsageError"
}

export const USAGE_EXIT_CODE = 2

const VERIFY_CHOICES: readonly VerifyChoice[] = ["fast", "full", "skip"]
const SMART_CHOICES: readonly SmartChoice[] = ["short", "long", "skip"]

export const FLAGS_HELP = `Flags (each one skips its question):
  --drive <name>        Disk holding the backup partition, for example sda
  --verify <type>       create: fast | full | skip            [fast]
  --smart <type>        create, verify: short | long | skip   [short]
  --use-mounted         Keep the drive's current mount point instead of remounting
  --delete-missing      create: delete repositories that are on the drive but not local
  --overwrite-local     restore: confirm overwriting the local folders
  -y, --yes             Ask nothing; a question without a flag takes its default

Without a terminal on stdin the script runs as if --yes were given. Then
--drive is required, drive-only repositories stop the run unless
--delete-missing is given, restore needs --overwrite-local, and the drive is
never formatted. Exit codes: 0 done, 1 failed, 2 wrong flags or missing answer.`

/**
 * Parses the flags after the command. `stdinIsTerminal` decides whether a
 * question may be asked at all when `--yes` is absent.
 */
export function parseOptions(args: string[], stdinIsTerminal: boolean): Options {
  const parsed = parseArgs(args, {
    string: ["drive", "verify", "smart"],
    boolean: ["yes", "use-mounted", "delete-missing", "overwrite-local"],
    alias: { y: "yes" },
    unknown: (arg) => {
      throw new UsageError(`Unknown argument: ${arg}`)
    },
  })

  const drive = parsed.drive?.replace(/^\/dev\//, "")
  if (drive !== undefined && !/^[a-zA-Z0-9]+$/.test(drive)) {
    throw new UsageError(`--drive takes a disk name such as sda, got "${parsed.drive}"`)
  }

  return {
    interactive: stdinIsTerminal && !parsed.yes,
    drive,
    verify: oneOf("--verify", parsed.verify, VERIFY_CHOICES),
    smart: oneOf("--smart", parsed.smart, SMART_CHOICES),
    useMounted: parsed["use-mounted"],
    deleteMissing: parsed["delete-missing"],
    overwriteLocal: parsed["overwrite-local"],
  }
}

function oneOf<T extends string>(
  flag: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined
  const lower = value.toLowerCase()
  if (!(allowed as readonly string[]).includes(lower)) {
    throw new UsageError(`${flag} takes ${allowed.join(" | ")}, got "${value}"`)
  }
  return lower as T
}

/**
 * The answer to a question with a safe default: the flag when given, the
 * default when nothing may be asked, otherwise the operator's reply.
 */
export function choose(
  options: Options,
  flagValue: string | undefined,
  question: string,
  fallback: string,
): string {
  if (flagValue !== undefined) return flagValue
  if (!options.interactive) return fallback
  return prompt(question) || fallback
}

/**
 * The drive to work on. A non-interactive run without `--drive` throws:
 * there is no safe default, and guessing one could format or overwrite the
 * wrong disk. Returns null when the operator enters nothing.
 */
export function chooseDrive(options: Options): string | null {
  if (options.drive) return options.drive
  if (!options.interactive) {
    throw new UsageError("No drive given: pass --drive <name>, for example --drive sda")
  }
  return prompt("\n🔍 Enter drive name (e.g., 'sda'): ")?.trim() || null
}

/**
 * Whether to overwrite the local folders with the drive's copy. Only
 * `--overwrite-local` or a typed RESTORE confirms it; `--yes` alone never does.
 */
export function confirmRestore(options: Options): boolean {
  if (options.overwriteLocal) return true
  if (!options.interactive) return false
  return prompt("\n⚠️  Type 'RESTORE' to restore all backups to local folders: ") === "RESTORE"
}
