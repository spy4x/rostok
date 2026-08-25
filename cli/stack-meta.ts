// StackMeta type + arktype schema.
//
// Per docs/v1-cli.md §4, each stack ships a `+meta.ts` that exports
// `default { ... } satisfies StackMeta`. This module defines the contract:
// the runtime shape (arktype schema) and the compile-time type that
// `satisfies` checks against.
//
// Validation library: arktype 2.x (https://arktype.io). Chosen over zod
// for "faster + leaner" claim; composes with cliffy via Type<T> wrapping
// (see cli/arktype-type.ts).

import { ArkErrors, type } from "arktype"
import { unsupportedReferences } from "./defaults.ts"

// Public type — what `+meta.ts` authors write `satisfies StackMeta` against.
export interface VariableSpec {
  /** Env-var style identifier. Required. */
  key: string
  /** Interactive prompt text. Optional — when omitted and required=true, default is the key. */
  question?: string
  /**
   * Default value. Two forms:
   * - string: stored verbatim, with `${SERVER_NAME}` substituted at resolution.
   * - () => string | undefined: called lazily; undefined falls through to prompt/skip.
   */
  default?: string | (() => string | undefined)
  /** When true (default), missing value requires prompt. When false, variable is omitted. */
  required?: boolean
  /** When true, value is never echoed/logged. Routed through age64 by the writer. */
  secret?: boolean
}

export interface StackMeta {
  /** Stack identifier — matches directory name under `stacks/`. */
  name: string
  /** One-line description shown in catalog listings. */
  description: string
  /** Catalog grouping: proxy, monitoring, media, productivity, infra. */
  category?: string
  /** Ordered list of environment variables this stack declares. */
  variables: VariableSpec[]
}

// Runtime schemas — defense-in-depth beyond TypeScript's `satisfies` check.
// Authors who hand-author a malformed `+meta.ts` get a clean error from
// `validateStackMeta()` rather than a cryptic TypeScript diagnostic.

const VariableSpec: type.Any = type({
  key: "string > 0",
  "question?": "string",
  // `default` accepts string or function. arktype's DSL can't type
  // functions, so we declare it `unknown` and narrow below.
  "default?": "unknown",
  "required?": "boolean",
  "secret?": "boolean",
}).narrow((value, ctx) => {
  // Narrow the `default` field: must be string, function, or undefined.
  const def = value.default
  if (def !== undefined && typeof def !== "string" && typeof def !== "function") {
    return ctx.mustBe("a string or function")
  }
  return true
})

export const VariableSpecSchema: type.Any = VariableSpec

export const StackMetaSchema: type.Any = type({
  name: "string > 0",
  description: "string > 0",
  "category?": "string",
  variables: VariableSpec.array(),
})

/**
 * Validate an unknown value as a StackMeta. Throws with a human-readable
 * message on failure. Phase 5's loader will call this after importing
 * `+meta.ts` from each catalog entry.
 */
export function validateStackMeta(input: unknown): StackMeta {
  const result = StackMetaSchema(input)
  if (result instanceof ArkErrors) {
    throw new Error(`Invalid +meta.ts: ${summarizeArkErrors(result)}`)
  }
  // Secondary pass: reject unsupported `${...}` references in string defaults.
  // Per docs/v1-cli.md §4 only `${SERVER_NAME}` is allowed in v1.
  for (const v of result.variables) {
    if (typeof v.default === "string") {
      const bad = unsupportedReferences(v.default)
      if (bad.length > 0) {
        throw new Error(
          `Invalid +meta.ts: variable "${v.key}" uses unsupported reference(s): ${
            bad.join(", ")
          }. only \${SERVER_NAME} is allowed in v1.`,
        )
      }
    }
  }
  return result as StackMeta
}

/**
 * arktype's `ArkErrors.summary` returns one line per failing field, joined
 * with `\n`. CLI output wants a single line. Normalize for thrown messages.
 */
function summarizeArkErrors(errors: ArkErrors): string {
  return errors.summary.replace(/\n+/g, "; ")
}

/**
 * Normalize a VariableSpec by filling in defaults for optional fields.
 * Caller is responsible for applying this to every spec before evaluating
 * the prompt rule.
 */
export function normalizeVariableSpec(
  spec: VariableSpec,
): Required<Pick<VariableSpec, "required" | "secret">> & VariableSpec {
  return {
    ...spec,
    required: spec.required ?? true,
    secret: spec.secret ?? false,
  }
}
