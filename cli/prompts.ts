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

import { Confirm, Input, Secret } from "@cliffy/prompt"
import { UserError } from "./errors.ts"

/** The subset of cliffy's Input/Secret.prompt options promptValue actually uses. */
export interface PromptBase {
  message: string
  default?: string
  validate?: (v: string) => true | string
}

/**
 * Replaces the interactive cliffy call inside {@link promptValue}. Tests
 * inject a fake one (capture the label, return a canned value) instead
 * of needing a real TTY — cliffy's `Input`/`Secret.prompt` hang forever
 * against a non-interactive stdin.
 */
export type PromptFn = (base: PromptBase, secret: boolean) => Promise<string>

/** Real prompt: cliffy's `Secret.prompt` when `secret`, `Input.prompt` otherwise. */
export const defaultPromptFn: PromptFn = (base, secret) =>
  secret ? Secret.prompt(base) : Input.prompt(base)

/** Replaces cliffy's `Confirm.prompt` for yes/no questions (e.g. stack-add's requires prompt). */
export type ConfirmFn = (opts: { message: string; default?: boolean }) => Promise<boolean>

/** Real confirm: cliffy's `Confirm.prompt`. */
export const defaultConfirmFn: ConfirmFn = (opts) => Confirm.prompt(opts)

/**
 * Append the `--var` key to a human prompt label, e.g.
 * `withKeyLabel("Server name, used as a folder name", "SERVER_NAME")` →
 * `"Server name, used as a folder name (SERVER_NAME)"`. #212: every
 * prompt shows its key so a hobbyist learns the exact `--var` flag to
 * pass next time, instead of only seeing an internal field name like
 * `serverName`.
 */
export function withKeyLabel(label: string, key: string): string {
  return `${label} (${key})`
}

export interface PromptValueOptions {
  /** The `--var KEY` name. Used to look up `provided` and in the missing-value error. */
  key: string
  /** Human-readable label shown as the interactive prompt message. */
  label: string
  /** Pre-supplied value (e.g. from --var KEY=VAL). Wins if present. */
  provided?: string
  /** Default value shown in the interactive prompt (and applied on Enter). */
  fallback?: string
  /**
   * Validator, checked against whichever value resolves — `provided`,
   * `fallback` (non-interactive), or what the user types (interactive).
   * Return `true` to accept, a string to reject. A `--var` or an
   * existing `.env` value is just as untrusted as interactive input:
   * skipping validation for them would let e.g. `--var
   * SSH_ADDRESS=-oProxyCommand=...` through unchecked.
   */
  validate?: (v: string) => true | string
  /** Hide input (use cliffy Secret.prompt). */
  secret?: boolean
  /** Skip the interactive prompt entirely; resolve from `fallback` or throw. */
  nonInteractive?: boolean
  /** Test injection point — see {@link PromptFn}. Defaults to the real cliffy prompt. */
  promptFn?: PromptFn
}

/**
 * Run `validate` (if any) and throw a UserError naming `key` on rejection.
 *
 * Some `validate` functions (e.g. server-keys.ts's `validateSshAddress`,
 * adapted via `toValidator`) already return a message that starts with
 * `invalid <key>` — prefixing again would print
 * "invalid SSH_ADDRESS: invalid SSH_ADDRESS …". Only add the prefix when
 * the message doesn't already carry it.
 */
function assertValid(opts: PromptValueOptions, value: string): void {
  if (!opts.validate) return
  const result = opts.validate(value)
  if (result !== true) {
    const message = result.startsWith(`invalid ${opts.key}`)
      ? result
      : `invalid ${opts.key}: ${result}`
    throw new UserError(message)
  }
}

/**
 * Resolve a value with the strict-default policy: prefer a provided value,
 * then the fallback (if any), then prompt (or fail).
 *
 * In non-interactive mode (`nonInteractive: true`), this returns
 * `fallback` when one exists — matching "-n skips prompts, uses
 * defaults" — and throws a `UserError` only when neither `provided` nor
 * `fallback` exists. `validate` runs on the resolved value regardless of
 * which path produced it.
 */
export async function promptValue(opts: PromptValueOptions): Promise<string> {
  if (opts.provided !== undefined) {
    assertValid(opts, opts.provided)
    return opts.provided
  }
  if (opts.nonInteractive) {
    if (opts.fallback !== undefined) {
      assertValid(opts, opts.fallback)
      return opts.fallback
    }
    throw new UserError(`missing ${opts.key}: pass --var ${opts.key}=<value>`)
  }
  const base: PromptBase = {
    message: opts.label,
    default: opts.fallback,
    validate: opts.validate,
  }
  const promptFn = opts.promptFn ?? defaultPromptFn
  const value = await promptFn(base, !!opts.secret)
  // cliffy's own prompt loop already re-asks on a failing `validate` —
  // this is defense in depth for a non-TTY edge case where cliffy
  // accepts a value it shouldn't (e.g. a piped default with no re-ask).
  assertValid(opts, value)
  return value
}
