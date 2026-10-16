import { assertEquals } from "@std/assert"
import {
  BackupOutcome,
  classifyBackupOutcome,
  exitCodeFor,
  formatOutcomeBanner,
} from "./outcome.ts"
import type { VerificationDetail, VerifyResults } from "./types.ts"

function results(
  partial: Partial<VerifyResults> & { details?: VerificationDetail[] } = {},
): VerifyResults {
  return {
    passed: partial.passed ?? 0,
    failed: partial.failed ?? 0,
    skipped: partial.skipped ?? 0,
    details: partial.details ?? [],
  }
}

Deno.test({
  // The 2026-08 incident: repositories failed and the run still printed
  // the green banner.
  name: "classifyBackupOutcome reports Failed when a repository failed",
  fn() {
    const outcome = classifyBackupOutcome(true, true, results({ passed: 3, failed: 1 }))
    assertEquals(outcome, BackupOutcome.Failed)
    assertEquals(exitCodeFor(outcome), 1)
  },
})

Deno.test({
  // The gap the 2026-08 fix left open: verification that proves nothing
  // is not a success. `failed === 0` is reachable with `passed === 0`
  // when restic is missing and the operator waives the check, when a
  // target directory cannot be listed, and when a target holds no
  // repositories.
  name: "classifyBackupOutcome reports Unverified when verification checked nothing",
  fn() {
    const outcome = classifyBackupOutcome(true, true, results())
    assertEquals(outcome, BackupOutcome.Unverified)
    assertEquals(exitCodeFor(outcome), 1)
  },
})

Deno.test({
  // Skipped repositories are not proof either: a target full of
  // directories that are not restic repositories leaves passed at zero.
  name: "classifyBackupOutcome reports Unverified when every repository was skipped",
  fn() {
    const outcome = classifyBackupOutcome(true, true, results({ skipped: 4 }))
    assertEquals(outcome, BackupOutcome.Unverified)
  },
})

Deno.test({
  // A deliberate skip is the operator's call, so it must not fail the
  // run — but it must not claim verification either.
  name: "classifyBackupOutcome reports SkippedByOperator and exits zero",
  fn() {
    const outcome = classifyBackupOutcome(true, false, results())
    assertEquals(outcome, BackupOutcome.SkippedByOperator)
    assertEquals(exitCodeFor(outcome), 0)
  },
})

Deno.test({
  name: "classifyBackupOutcome reports Verified only when a repository passed",
  fn() {
    const outcome = classifyBackupOutcome(true, true, results({ passed: 2 }))
    assertEquals(outcome, BackupOutcome.Verified)
    assertEquals(exitCodeFor(outcome), 0)
  },
})

Deno.test({
  // A failed sync outranks a clean verification tally, and must not be
  // described as a verification failure.
  name: "classifyBackupOutcome reports Failed when sync failed even with no failed repos",
  fn() {
    const outcome = classifyBackupOutcome(false, true, results({ passed: 2 }))
    assertEquals(outcome, BackupOutcome.Failed)
    assertEquals(exitCodeFor(outcome), 1)
  },
})

Deno.test({
  // A sync failure must not be described as a verification failure. No
  // call site can reach this today — `syncBackups` throws rather than
  // returning false — so this guards the classifier's contract, not a
  // live path.
  name: "formatOutcomeBanner does not claim failed verifications when none failed",
  fn() {
    const lines = formatOutcomeBanner(BackupOutcome.Failed, results({ passed: 2 }))
    assertEquals(lines, ["\n❌ Backup FAILED — the sync step did not complete."])
  },
})

Deno.test({
  name: "formatOutcomeBanner names every failed repository",
  fn() {
    const lines = formatOutcomeBanner(
      BackupOutcome.Failed,
      results({
        passed: 1,
        failed: 2,
        details: [
          { name: "home/vaultwarden", status: "failed" },
          { name: "home/immich", status: "failed" },
          { name: "home/traggo", status: "passed" },
        ],
      }),
    )
    assertEquals(lines, [
      "\n❌ Backup FAILED — 2 repository verification(s) failed:",
      "     - home/vaultwarden",
      "     - home/immich",
    ])
  },
})

Deno.test({
  name: "formatOutcomeBanner distinguishes an unverified run from a successful one",
  fn() {
    const verified = formatOutcomeBanner(BackupOutcome.Verified, results({ passed: 5 }))
    assertEquals(verified.length, 1)
    assertEquals(verified[0].includes("5 repository check(s) passed"), true)

    const unverified = formatOutcomeBanner(BackupOutcome.Unverified, results())
    assertEquals(unverified[0].includes("NOT VERIFIED"), true)
    assertEquals(unverified[0].includes("✅"), false)
  },
})

Deno.test({
  // Verify mode checks a drive that already exists; it takes no backup,
  // so the shared banner must not claim one.
  name: "formatOutcomeBanner names the subject given to it",
  fn() {
    const verified = formatOutcomeBanner(
      BackupOutcome.Verified,
      results({ passed: 5 }),
      "Verification",
    )
    assertEquals(verified[0].includes("Verification completed successfully"), true)
    assertEquals(verified[0].includes("Backup"), false)

    const failed = formatOutcomeBanner(
      BackupOutcome.Failed,
      results({ failed: 1, details: [{ name: "home/immich", status: "failed" }] }),
      "Verification",
    )
    assertEquals(failed[0].includes("Verification FAILED"), true)

    const unverified = formatOutcomeBanner(BackupOutcome.Unverified, results(), "Verification")
    assertEquals(unverified[0].includes("Verification NOT VERIFIED"), true)
  },
})

Deno.test({
  // The saved log's name must agree with the exit code: a deliberately
  // unverified run exits zero and must not be filed as `_failed.log`.
  name: "exitCodeFor agrees with the log success flag for a deliberate skip",
  fn() {
    const outcome = classifyBackupOutcome(true, false, results())
    assertEquals(outcome, BackupOutcome.SkippedByOperator)
    assertEquals(exitCodeFor(outcome) === 0, true)
  },
})

Deno.test({
  name: "formatOutcomeBanner defaults its subject to Backup",
  fn() {
    const lines = formatOutcomeBanner(BackupOutcome.Verified, results({ passed: 1 }))
    assertEquals(lines[0].includes("Backup completed successfully"), true)
  },
})
