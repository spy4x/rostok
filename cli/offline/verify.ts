// Checks: `restic check` on every repository, the drive's SMART
// self-test, and folder sizes.

import { join } from "@std/path"
import { formatBytes } from "@spy4x/platform/universal/format-number"
import type { OfflineDeps, Reporter } from "./context.ts"
import { ensureSudo, formatSmartSkipMessage } from "./sudo.ts"
import type { VerifyResults } from "./types.ts"

/** A folder holding restic repositories, with the name used in the results. */
export interface RepoRoot {
  name: string
  path: string
}

/** The size of a folder from `du -sb`; `human` is "unknown" when du fails. */
export async function getSize(
  deps: OfflineDeps,
  path: string,
): Promise<{ bytes: number; human: string }> {
  const result = await deps.runner.run(["du", "-sb", path])
  const bytes = result.success ? parseInt(result.output.split("\t")[0]) : NaN
  if (!Number.isFinite(bytes)) return { bytes: 0, human: "unknown" }
  return { bytes, human: formatBytes(bytes) }
}

/**
 * Runs `restic check` (with `--read-data` when `full`) on every
 * repository directly under each root. A folder without a `config` file
 * is not a restic repository and counts as skipped. Reports what it
 * found; the caller decides what that means (see outcome.ts).
 */
export async function verifyRepos(
  deps: OfflineDeps,
  out: Reporter,
  roots: RepoRoot[],
  password: string,
  full: boolean,
): Promise<VerifyResults> {
  const results: VerifyResults = { passed: 0, failed: 0, skipped: 0, details: [] }
  for (const root of roots) {
    const repos: string[] = []
    try {
      for await (const entry of Deno.readDir(root.path)) {
        if (!entry.isDirectory) continue
        const name = `${root.name}/${entry.name}`
        try {
          await Deno.stat(join(root.path, entry.name, "config"))
          repos.push(entry.name)
        } catch {
          results.skipped++
          results.details.push({ name, status: "skipped" })
        }
      }
    } catch (error) {
      out.warn(`Could not list ${root.path}: ${error instanceof Error ? error.message : error}`)
      continue
    }
    if (repos.length === 0) out.line(`   ${root.name}: no restic repositories`)
    for (const repo of repos.sort()) {
      const name = `${root.name}/${repo}`
      const result = await deps.runner.run(
        ["restic", "-r", join(root.path, repo), "check", ...(full ? ["--read-data"] : [])],
        { env: { RESTIC_PASSWORD: password } },
      )
      if (result.success) {
        out.line(`   ✓ ${name}`)
        results.passed++
        results.details.push({ name, status: "passed" })
      } else {
        const error = result.error.trim().split("\n")[0] || "restic check failed"
        out.line(`   ✗ ${name}: ${error}`)
        results.failed++
        results.details.push({ name, status: "failed", error })
      }
    }
  }
  out.line(
    `   ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped ` +
      `(not restic repositories)`,
  )
  return results
}

/** How the SMART step ended, for the summary. */
export interface SmartResult {
  /** "skipped" covers `--smart skip`, a missing smartctl and missing sudo. */
  status: "passed" | "failed" | "unknown" | "skipped"
  /** One line for the summary. */
  summary: string
  /** The health line and recent self-test log, for the log file. */
  details: string
}

const SMART_POLL_MS = 4 * 60 * 1000

/**
 * Starts a SMART self-test, waits for it and reads the drive's health.
 * Skips, with the manual command, when smartctl is missing or sudo would
 * need a password that nobody can type.
 */
export async function runSmartCheck(
  deps: OfflineDeps,
  out: Reporter,
  device: string,
  checkType: "short" | "long",
  interactive: boolean,
): Promise<SmartResult> {
  if (!(await deps.hasCommand("smartctl"))) {
    out.warn("smartctl is not installed (package smartmontools): SMART test skipped.")
    return { status: "skipped", summary: "skipped: smartctl not installed", details: "" }
  }
  if (!(await ensureSudo(deps, out, interactive, "the SMART test"))) {
    for (const line of formatSmartSkipMessage(checkType, device)) out.warn(line)
    return { status: "skipped", summary: "skipped: sudo needs a password", details: "" }
  }
  const estimatedMinutes = checkType === "short" ? 2 : 390
  const start = await deps.runner.run(["smartctl", "-t", checkType, device], { sudo: true })
  const startText = start.output + start.error
  if (!/has begun|Self-test execution status|Testing has begun/.test(startText)) {
    out.warn(`Could not start the SMART test: ${startText.trim().split("\n").pop() ?? ""}`)
    return { status: "unknown", summary: "could not start the test", details: startText }
  }
  out.line(`   ${checkType} test started, about ${estimatedMinutes} min`)

  const testLines = async () =>
    (await deps.runner.run(["smartctl", "-l", "selftest", device], { sudo: true })).output
      .split("\n").filter((line) => /^\s*#\s*\d+/.test(line)).length
  const initialTests = await testLines()
  const startedAt = deps.now()
  while (true) {
    await deps.sleep(checkType === "short" ? 30_000 : SMART_POLL_MS)
    const elapsedMin = Math.floor((deps.now() - startedAt) / 60_000)
    const status = await deps.runner.run(["smartctl", "-a", device], { sudo: true })
    if (!status.success && !status.output) {
      out.warn(`Lost sudo while waiting; check by hand: sudo smartctl -a ${device}`)
      break
    }
    const text = status.output + status.error
    const remaining = text.match(/(\d+)% of test remaining/)
    if (remaining || text.includes("Self-test routine in progress")) {
      out.line(`   still running: ${remaining ? `${remaining[1]}% left` : `${elapsedMin} min`}`)
    } else if ((await testLines()) > initialTests) {
      break
    }
    if (elapsedMin > estimatedMinutes * 1.5) {
      out.warn(`The SMART test takes longer than expected; check: sudo smartctl -a ${device}`)
      break
    }
  }

  const report = (await deps.runner.run(["smartctl", "-a", device], { sudo: true })).output
  const health = report.match(/SMART overall-health.*:\s*(.+)/)?.[1]?.trim()
  const logStart = report.indexOf("SMART Self-test log")
  const recent = logStart > -1
    ? report.slice(logStart).split("\n").filter((l) => l.trim()).slice(0, 8)
    : []
  for (const line of recent) out.line(`   ${line}`)
  const details = [health ? `Overall health: ${health}` : "", ...recent].filter(Boolean).join(
    "\n",
  )
  if (!health) {
    return { status: "unknown", summary: `${checkType} test, health unknown`, details }
  }
  const passed = health.includes("PASSED")
  return {
    status: passed ? "passed" : "failed",
    summary: `${checkType} test, health ${health}`,
    details,
  }
}
