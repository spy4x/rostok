// Public API of the rostok CLI. Imported by `+meta.ts` files in `stacks/<name>/`
// and (eventually) by end-user projects that consume the published JSR package.
//
// Per docs/v1-cli.md §4, stack authors write:
//
//   import type { StackMeta } from "@rostok/cli"
//   import { generatePassword } from "@rostok/cli"
//
//   export default { ... } satisfies StackMeta
//
// This barrel re-exports the runtime API + types those authors need.

// Stack meta types + arktype schemas.
export type { StackMeta, VariableSpec } from "./stack-meta.ts"
export {
  normalizeVariableSpec,
  StackMetaSchema,
  validateStackMeta,
  VariableSpecSchema,
} from "./stack-meta.ts"

// Password generator for `default: () => generatePassword(N)`.
export { generatePassword, passwordEntropyBits } from "./secrets.ts"

// Default value resolution (`${SERVER_NAME}` substitution, lazy defaults).
export type { ResolvedValue } from "./defaults.ts"
export { resolveReferences, resolveVariable, unsupportedReferences } from "./defaults.ts"

// Prompt rule — when to ask, use default, or skip.
export type { PromptDecision } from "./prompt-rule.ts"
export { decidePrompt } from "./prompt-rule.ts"

// cliffy Type<T> wrapper for arktype schemas (Phase 5 wires real args).
export { arktypeToCliffy, ArktypeType } from "./arktype-type.ts"
