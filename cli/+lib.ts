/**
 * Library API of rostok, the CLI that scaffolds a self-hosted homelab from a
 * catalog of Docker Compose stacks and deploys it over SSH.
 *
 * Each catalog stack ships a `+meta.ts` that declares its variables with
 * {@linkcode StackMeta}. This module holds that type, its runtime schemas, the
 * password generator for secret defaults, and the rules rostok uses to resolve
 * a default or decide whether to prompt. The CLI itself is the package's
 * default export: `deno install -A -n rostok jsr:@rostok/cli`.
 *
 * @example A stack's `+meta.ts`
 * ```ts
 * import { generatePassword, type StackMeta } from "jsr:@rostok/cli/lib"
 *
 * export default {
 *   name: "whoami",
 *   description: "Echo server that prints the request it received",
 *   requires: ["traefik"],
 *   variables: [
 *     { key: "WHOAMI_HOST", default: "whoami.${DOMAIN}" },
 *     { key: "WHOAMI_TOKEN", default: () => generatePassword(32), secret: true },
 *   ],
 * } satisfies StackMeta
 * ```
 *
 * @module
 */

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
export type { ResolvedValue, ServerContext } from "./defaults.ts"
export { resolveReferences, resolveVariable, unsupportedReferences } from "./defaults.ts"

// Prompt rule — when to ask, use default, or skip.
export type { PromptDecision } from "./prompt-rule.ts"
export { decidePrompt } from "./prompt-rule.ts"

// cliffy Type<T> wrapper for arktype schemas (Phase 5 wires real args).
export { arktypeToCliffy, ArktypeType } from "./arktype-type.ts"
