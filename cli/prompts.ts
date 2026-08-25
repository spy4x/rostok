// Shared prompt helpers.
//
// Both server-create and stack-add need the same flow:
//   1. Use the pre-supplied value if present (from --var or a pre-supplied
//      map).
//   2. Throw if non-interactive (the strict-default policy — per
//      docs/v1-cli.md §3.4, every required var must have a default or
//      --var; missing both means fail loud).
//   3. Otherwise prompt interactively (Input for normal, Secret for hidden).
//
// Extracts the pattern that previously lived twice in server-create.ts
// (`ask()`) and stack-add.ts (`promptFor()`).

import { Input, Secret } from "@cliffy/prompt"

export interface PromptValueOptions {
  /** Human-readable label. Used as the prompt message and in error text. */
  label: string
  /** Pre-supplied value (e.g. from --var KEY=VAL). Wins if present. */
  provided?: string
  /** Default value shown in the interactive prompt (and applied on Enter). */
  fallback?: string
  /** Validator for the interactive input. Return `true` to accept, string to reject. */
  validate?: (v: string) => true | string
  /** Hide input (use cliffy Secret.prompt). */
  secret?: boolean
  /** Skip the interactive prompt entirely; throw if `provided` is missing. */
  nonInteractive?: boolean
}

/**
 * Resolve a value with the strict-default policy: prefer a provided value,
 * then the fallback (if any), then prompt (or fail).
 *
 * In non-interactive mode (when `nonInteractive: true`), this function
 * throws on missing values rather than prompting. The wizard passes
 * `nonInteractive: opts.nonInteractive` so `-n` / `--non-interactive` flows
 * fail fast instead of hanging on a TTY-less stdin.
 */
export async function promptValue(opts: PromptValueOptions): Promise<string> {
  if (opts.provided !== undefined) return opts.provided
  if (opts.nonInteractive) {
    throw new Error(
      `${opts.label}: missing required value in non-interactive mode. ` +
        `pass via --var KEY=VAL or provide a default.`,
    )
  }
  const base = {
    message: opts.label,
    default: opts.fallback,
    validate: opts.validate,
  }
  if (opts.secret) return await Secret.prompt(base)
  return await Input.prompt(base)
}
