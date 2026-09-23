// Shared prompt helpers.
//
// Both server-create and stack-add need the same flow:
//   1. Use the pre-supplied value if present (from --var or a pre-supplied
//      map).
//   2. In non-interactive mode: fall back to `fallback` if one exists;
//      throw a UserError only when neither a value nor a fallback exists
//      (the strict-default policy — per docs/v1-cli.md §3.4, every
//      required var must have a default or --var; missing both means
//      fail loud, naming the exact flag to pass).
//   3. Otherwise prompt interactively (Input for normal, Secret for hidden).
//
// Extracts the pattern that previously lived twice in server-create.ts
// (`ask()`) and stack-add.ts (`promptFor()`).

import { Input, Secret } from "@cliffy/prompt"
import { UserError } from "./errors.ts"

export interface PromptValueOptions {
  /** The `--var KEY` name. Used to look up `provided` and in the missing-value error. */
  key: string
  /** Human-readable label shown as the interactive prompt message. */
  label: string
  /** Pre-supplied value (e.g. from --var KEY=VAL). Wins if present. */
  provided?: string
  /** Default value shown in the interactive prompt (and applied on Enter). */
  fallback?: string
  /** Validator for the interactive input. Return `true` to accept, string to reject. */
  validate?: (v: string) => true | string
  /** Hide input (use cliffy Secret.prompt). */
  secret?: boolean
  /** Skip the interactive prompt entirely; resolve from `fallback` or throw. */
  nonInteractive?: boolean
}

/**
 * Resolve a value with the strict-default policy: prefer a provided value,
 * then the fallback (if any), then prompt (or fail).
 *
 * In non-interactive mode (`nonInteractive: true`), this returns
 * `fallback` when one exists — matching "-n skips prompts, uses
 * defaults" — and throws a `UserError` only when neither `provided` nor
 * `fallback` exists.
 */
export async function promptValue(opts: PromptValueOptions): Promise<string> {
  if (opts.provided !== undefined) return opts.provided
  if (opts.nonInteractive) {
    if (opts.fallback !== undefined) return opts.fallback
    throw new UserError(`missing ${opts.key}: pass --var ${opts.key}=<value>`)
  }
  const base = {
    message: opts.label,
    default: opts.fallback,
    validate: opts.validate,
  }
  if (opts.secret) return await Secret.prompt(base)
  return await Input.prompt(base)
}
