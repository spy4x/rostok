// Shared `--var`/`--stack` flag parsing for cliffy command actions.
//
// Extracted out of cli/+main.ts so cli/commands/*.ts can reuse it
// without importing back into +main.ts (which would create a circular
// module dependency between +main.ts and its own subcommands).

import { UserError } from "./errors.ts"

/** Parse `--var KEY=VAL` flags into a record. */
export function parseVarFlags(flags: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  const flat = flattenCliffyCollect(flags)
  for (const f of flat) {
    const eq = f.indexOf("=")
    if (eq < 0) {
      throw new UserError(`--var requires KEY=VAL form, got: ${f}`)
    }
    out[f.slice(0, eq)] = f.slice(eq + 1)
  }
  return out
}

/** Parse repeatable `--stack <name>` flags into a plain string array. */
export function parseStackFlags(flags: unknown): string[] {
  return flattenCliffyCollect(flags)
}

/**
 * cliffy's `<...:string[]>` / `<...:string...>` with `collect: true`
 * produces a CIRCULAR structure: the last slot points back to the root
 * array. Walk to a bounded depth (strings live at depth 2 max) and bail
 * on cycles.
 */
function flattenCliffyCollect(flags: unknown): string[] {
  const flat: string[] = []
  if (!flags) return flat
  const seen = new WeakSet<object>()
  const walk = (v: unknown, depth: number) => {
    if (typeof v === "string") {
      flat.push(v)
      return
    }
    if (depth > 4 || v === null || typeof v !== "object") return
    if (seen.has(v as object)) return // cycle — stop
    seen.add(v as object)
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1)
    }
  }
  walk(flags, 0)
  return flat
}
