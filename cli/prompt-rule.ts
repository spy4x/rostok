// Prompt rule — when to ask the user for a value vs. use a default vs. omit.
//
// Per docs/v1-cli.md §4 (Prompt rule):
//
//   - required: true  + no default + no --var  → ask
//   - required: true  + default present        → use default, skip prompt
//   - required: false + default present        → use default, skip prompt
//   - required: false + no default             → omit, skip prompt
//
// `decidePrompt` consumes the resolved value (post --var/default lookup)
// and emits one of three decisions for the caller.

import type { VariableSpec } from "./stack-meta.ts"

export type PromptDecision = "use-resolved" | "prompt" | "skip"

/**
 * Decide whether to prompt the user, use the resolved value, or skip.
 *
 * @param spec  VariableSpec from the stack's +meta.ts (caller may pass
 *              a normalized copy with required/secret filled in).
 * @param resolved  Value from `resolveVariable()` — undefined when no
 *              default and no --var override exist.
 */
export function decidePrompt(
  spec: VariableSpec,
  resolved: string | undefined,
): PromptDecision {
  // Resolved value exists — use it (default or override), no prompt.
  if (resolved !== undefined) return "use-resolved"
  // No value available. Required means ask; optional means omit.
  if (spec.required === false) return "skip"
  return "prompt"
}
