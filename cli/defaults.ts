// Default value resolution for stack variables.
//
// Per docs/v1-cli.md §4:
//   - `--var KEY=VAL` overrides any default (caller passes via `providedValue`)
//   - `default: "literal"` with optional `${SERVER_NAME}` substitution
//   - `default: () => generatePassword(N)` — lazy, called once per resolution
//
// Only `${SERVER_NAME}` is supported as a reference in v1. Other server-
// level vars (e.g. `${DOMAIN}`) are out of scope and rejected by the regex.

import type { VariableSpec } from "./stack-meta.ts"

const SERVER_NAME_REF = "${SERVER_NAME}"
const SUPPORTED_REFS = [SERVER_NAME_REF] as const

/**
 * Resolve `${SERVER_NAME}` references inside a string default.
 * Multiple occurrences in the same string are all replaced.
 *
 * If new server-level references are added to the design later, list them
 * in `SUPPORTED_REFS` and extend this function — `unsupportedReferences`
 * below enforces the allow-list at resolution time.
 */
export function resolveReferences(value: string, serverName: string): string {
  if (!value.includes("$")) return value
  return value.split(SERVER_NAME_REF).join(serverName)
}

/**
 * Detect `${...}` references in a string that are NOT in the v1 allow-list.
 * Used by `validateStackMeta` and tests to flag unsupported references early.
 */
export function unsupportedReferences(value: string): string[] {
  const refs = value.match(/\$\{[^}]+\}/g) ?? []
  return refs.filter((ref) => !(SUPPORTED_REFS as readonly string[]).includes(ref))
}

export interface ResolvedValue {
  /** Final value written to .env / age64. */
  value: string
  /** True when the value came from a default (not `--var`). Secrets writing may want to know. */
  fromDefault: boolean
}

/**
 * Resolve a variable spec to a concrete value. Resolution order:
 *   1. `providedValue` (from `--var KEY=VAL` flag) — always wins.
 *   2. `default` if it's a function — called lazily.
 *   3. `default` if it's a string — references resolved.
 *   4. `null` — caller must prompt (or skip, per the prompt rule).
 */
export function resolveVariable(
  spec: VariableSpec,
  providedValue: string | undefined,
  serverName: string,
): ResolvedValue | null {
  if (providedValue !== undefined) {
    return { value: providedValue, fromDefault: false }
  }

  if (typeof spec.default === "function") {
    const generated = spec.default()
    if (generated !== undefined) {
      return { value: generated, fromDefault: true }
    }
    return null
  }

  if (typeof spec.default === "string") {
    return { value: resolveReferences(spec.default, serverName), fromDefault: true }
  }

  return null
}
