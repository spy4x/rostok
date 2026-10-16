// sudo preflight. Every sudo call in `rostok offline` runs as `sudo -n`,
// which fails at once instead of waiting for a password nobody can type
// (an unattended SMART run once hung for minutes on that). At a terminal
// the operator may type the password once, up front.

import type { OfflineDeps, Reporter } from "./context.ts"

/** True when `sudo -n true` succeeds: sudo works without a password right now. */
export async function hasPasswordlessSudo(deps: OfflineDeps): Promise<boolean> {
  return (await deps.runner.run(["true"], { sudo: true })).success
}

/**
 * Makes sure the next `sudo -n` calls work. Without passwordless sudo,
 * asks for the password once at a terminal (`sudo -v`); without a
 * terminal, returns false so the caller skips or refuses its step.
 */
export async function ensureSudo(
  deps: OfflineDeps,
  out: Reporter,
  interactive: boolean,
  purpose: string,
): Promise<boolean> {
  if (await hasPasswordlessSudo(deps)) return true
  if (!interactive) return false
  out.line(`sudo needs your password for ${purpose}.`)
  return await deps.runner.sudoLogin()
}

/** The message printed when the SMART test is skipped for want of sudo. */
export function formatSmartSkipMessage(checkType: "short" | "long", device: string): string[] {
  return [
    "SMART test skipped: sudo needs a password and there is no terminal to type it.",
    `   Run it by hand: sudo smartctl -t ${checkType} ${device}`,
  ]
}
