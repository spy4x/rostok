// Bridge: wrap an arktype schema in cliffy's Type<T>.
//
// Per docs/v1-cli.md §4:
//   "Composes with cliffy via Type<T> wrapping."
//
// cliffy's `Type` (from @cliffy/command) is an abstract class. To wire a
// custom validator, subclass it and override `parse({value, ...})`. arktype's
// Type, when called, returns either the parsed value or an `ArkErrors`
// instance. We translate the failure into a thrown Error so cliffy's
// argument parser surfaces it via its standard `error: ...` channel.
//
// Phase 3 ships the wrapper. Phase 5 wires it into real CLI args/options.

import { Type as CliffyType } from "@cliffy/command"
import type { ArgumentValue } from "@cliffy/command"
import { ArkErrors, type Type as ArktypeSchema } from "arktype"

/**
 * cliffy Type subclass that delegates parsing to an arktype schema.
 * Use via `cmd.type("name", new ArktypeType("name", schema))`.
 *
 * `T` should match the schema's output type. arktype 2.x does not enforce
 * the caller's declared `T` against the schema's inferred type — the cast
 * at parse() is best-effort. Misalignment surfaces as runtime type errors
 * downstream, not here.
 */
export class ArktypeType<T = unknown> extends CliffyType<T> {
  constructor(
    /** Name shown in --help output for args/options that use this type. */
    readonly typeName: string,
    /** arktype schema to delegate validation to. */
    readonly schema: ArktypeSchema<unknown>,
  ) {
    super()
  }

  override parse({ value }: ArgumentValue): T {
    const result = this.schema(value)
    if (result instanceof ArkErrors) {
      // `summary` is multi-line when multiple fields fail — flatten to
      // a single line so cliffy's stderr channel stays CLI-friendly.
      throw new Error(`${this.typeName}: ${flattenSummary(result.summary)}`)
    }
    return result as T
  }
}

/**
 * Convenience factory mirroring cliffy's `new Type(name, validator)` ergonomics.
 */
export function arktypeToCliffy<T>(
  name: string,
  schema: ArktypeSchema<unknown>,
): ArktypeType<T> {
  return new ArktypeType<T>(name, schema)
}

/** Replace newlines in arktype's summary with `; ` for single-line CLI output. */
function flattenSummary(summary: string): string {
  return summary.replace(/\n+/g, "; ")
}
