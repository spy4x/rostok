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

import { Type } from "@cliffy/command"
import type { ArgumentValue } from "@cliffy/command"
import { ArkErrors } from "arktype"

interface ArktypeCallable {
  (input: unknown): unknown
  // arktype's Type class has more members; we only need the callable form.
}

/**
 * cliffy Type subclass that delegates parsing to an arktype schema.
 * Use via `cmd.type("name", new ArktypeType("name", schema))`.
 */
export class ArktypeType<T = unknown> extends Type<T> {
  constructor(
    readonly typeName: string,
    readonly schema: ArktypeCallable,
  ) {
    super()
  }

  override parse({ value }: ArgumentValue): T {
    const result = this.schema(value)
    if (result instanceof ArkErrors) {
      // `summary` is a single-line, human-readable error string.
      throw new Error(`${this.typeName}: ${result.summary}`)
    }
    return result as T
  }
}

/**
 * Convenience factory mirroring cliffy's `new Type(name, validator)` ergonomics.
 */
export function arktypeToCliffy<T>(
  name: string,
  schema: ArktypeCallable,
): ArktypeType<T> {
  return new ArktypeType<T>(name, schema)
}
