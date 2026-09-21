import type { VerifyResults } from "./types.ts"

/**
 * How an offline-backup run ended, as far as the operator needs to know.
 *
 * `Unverified` exists because "no repository failed" is not the same as
 * "the backup is good": verification can finish having proved nothing
 * at all (restic missing and the operator waived it, a target directory
 * that could not be listed, a target holding no repositories). Those
 * runs used to print the same green banner as a fully verified one.
 */
export enum BackupOutcome {
  /** Sync finished and at least one repository passed verification. */
  Verified = 1,
  /** The operator chose to skip verification up front. Not an error. */
  SkippedByOperator,
  /** Verification ran but proved nothing — treat as a failed run. */
  Unverified,
  /** Sync failed, or at least one repository failed verification. */
  Failed,
}

/**
 * Classifies a finished run from the sync result and the verification
 * tally.
 *
 * `verificationRequested` is false only when the operator answered
 * `skip` at the verification prompt; a waived restic check inside
 * `verifyBackups` still counts as requested, because the operator asked
 * for verification and did not get it.
 *
 * Pure — no I/O, no globals — so every branch is unit-testable without
 * a drive, restic, or sudo.
 */
export function classifyBackupOutcome(
  syncSuccess: boolean,
  verificationRequested: boolean,
  results: VerifyResults,
): BackupOutcome {
  if (!syncSuccess) {
    return BackupOutcome.Failed
  }
  if (results.failed > 0) {
    return BackupOutcome.Failed
  }
  if (!verificationRequested) {
    return BackupOutcome.SkippedByOperator
  }
  if (results.passed === 0) {
    return BackupOutcome.Unverified
  }
  return BackupOutcome.Verified
}

/**
 * Exit code for a finished run. Only a deliberate operator skip and a
 * fully verified run are successes; a run that verified nothing exits
 * non-zero so cron, a wrapper script, or a watching operator sees it.
 */
export function exitCodeFor(outcome: BackupOutcome): number {
  return outcome === BackupOutcome.Verified || outcome === BackupOutcome.SkippedByOperator ? 0 : 1
}

/**
 * The summary banner for a finished run. Returns the lines to print, so
 * the wording of each outcome is testable without capturing stdout.
 *
 * `subject` names what the run did, because the same classifier serves
 * `create` (which takes a backup) and `verify` (which only checks a
 * drive that already exists). Saying "Backup completed successfully"
 * after a verify-only run would claim work that never happened.
 */
export function formatOutcomeBanner(
  outcome: BackupOutcome,
  results: VerifyResults,
  subject: "Backup" | "Verification" = "Backup",
): string[] {
  switch (outcome) {
    case BackupOutcome.Verified:
      return [
        `\n✅ ${subject} completed successfully — ${results.passed} repository check(s) passed.`,
      ]
    case BackupOutcome.SkippedByOperator:
      return [
        `\n⚠️  ${subject} completed but NOT VERIFIED — you chose to skip verification.`,
        `   Run 'deno task offline-backup verify' to check the drive.`,
      ]
    case BackupOutcome.Unverified:
      return [
        `\n❌ ${subject} NOT VERIFIED — verification ran but checked no repositories.`,
        `   Nothing failed, but nothing passed either, so the drive is unproven.`,
        `   This is where you land if you waived the missing-restic warning, if a`,
        `   target directory could not be listed, or if it holds no repositories.`,
      ]
    case BackupOutcome.Failed: {
      const failedNames = results.details
        .filter((d) => d.status === "failed")
        .map((d) => d.name)
      if (failedNames.length === 0) {
        return [`\n❌ ${subject} FAILED — the sync step did not complete.`]
      }
      return [
        `\n❌ ${subject} FAILED — ${results.failed} repository verification(s) failed:`,
        ...failedNames.map((name) => `     - ${name}`),
      ]
    }
  }
}
