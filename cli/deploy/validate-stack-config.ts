// Validates every stack's `name` and `deployAs` from config.json before
// anything is built (#203 hardening, requested in review).
//
// Neither ships with its own character-set restriction (unlike a server
// name, which `serverDirFor` restricts to `^[a-z0-9][a-z0-9-]{0,62}$`).
// Every value that reaches a remote command is single-quoted (see
// exec.ts's `shQuote`), which stops `$(...)`/backtick execution and
// embedded-quote breakage — but a literal newline in a stack name or
// `deployAs` could still break out of one of the generated deploy
// script's `#` comment lines into executable text (comments don't get
// quoted; there's nothing to quote a comment against). This closes that
// gap at the source instead: reject anything outside a safe character
// set before staging even starts.

import { UserError } from "../errors.ts"
import { hasReservedStackKeyPrefix, stackKeyPrefix } from "../server-keys.ts"
import type { StackConfig } from "./deploy-script.ts"

/** Lowercase letters, digits, dashes and underscores; starts with a letter or digit; at most 63 characters. */
export const STACK_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/

function validateStackValue(value: string, field: string, configPath: string): void {
  if (!STACK_NAME_PATTERN.test(value)) {
    throw new UserError(
      `invalid ${field} "${value}" in ${configPath}: use lowercase letters, digits, dashes ` +
        `and underscores, start with a letter or digit, at most 63 characters.`,
    )
  }
}

/**
 * Validate every stack's `name` and `deployAs` (when set). Throws on the
 * first bad value, naming it, the field, and `configPath`.
 */
export function validateStackConfigs(stacks: StackConfig[], configPath: string): void {
  for (const stack of stacks) {
    validateStackValue(stack.name, "stack name", configPath)
    if (stack.deployAs !== undefined) {
      validateStackValue(stack.deployAs, "deployAs", configPath)
    }
    // A stack whose own key-prefix (stackKeyPrefix) starts with a
    // reserved prefix (GIT_, DOCKER_, SSH_, ...) would let its
    // .env-sourced keys collide with names tools a hook spawns treat
    // specially — reject it at deploy time, not just at `stack add`
    // (a project's stacks/<name>/ can bypass `stack add` entirely).
    if (hasReservedStackKeyPrefix(stack.name)) {
      throw new UserError(
        `stack "${stack.name}" in ${configPath}: its own key prefix "${
          stackKeyPrefix(stack.name)
        }" is reserved — rename the stack.`,
      )
    }
  }
}
