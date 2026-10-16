// The closing summary of `backup` and `verify`.

import { formatBytes } from "@spy4x/platform/universal/format-number"
import type { OfflineDeps } from "./context.ts"
import { formatDuration } from "./context.ts"
import type { VerifyResults } from "./types.ts"

/** Free and total space of the filesystem at `path`, from `df`; undefined when df fails. */
export async function driveSpace(deps: OfflineDeps, path: string): Promise<string | undefined> {
  const result = await deps.runner.run(["df", "-B1", "--output=size,avail", path])
  const numbers = result.output.split("\n")[1]?.trim().split(/\s+/).map(Number)
  if (!result.success || !numbers || numbers.length < 2 || numbers.some(isNaN)) return undefined
  return `${formatBytes(numbers[1])} free of ${formatBytes(numbers[0])}`
}

/** `5 passed, 1 failed, 2 skipped`, or why there was no check. */
export function describeChecks(results: VerifyResults | undefined): string {
  if (!results) return "skipped (--check skip)"
  return `${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped`
}

/** Aligned `  Label:  value` lines. */
export function summaryLines(rows: [string, string | undefined][], elapsedMs: number): string[] {
  const all: [string, string][] = [
    ...rows.filter((r): r is [string, string] => r[1] !== undefined),
    ["Duration", formatDuration(elapsedMs)],
  ]
  const width = Math.max(...all.map(([label]) => label.length)) + 1
  return ["", "Summary", ...all.map(([label, value]) => `  ${`${label}:`.padEnd(width)} ${value}`)]
}
