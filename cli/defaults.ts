// Default value resolution for stack variables.
//
// Per docs/v1-cli.md §4:
//   - `--var KEY=VAL` overrides any default (caller passes via `providedValue`)
//   - `default: "literal"` with optional substitution via ${KEY} placeholders
//   - `default: () => generatePassword(N)` — lazy, called once per resolution
//
// v1 supports these well-known server-level references inside string
// defaults. The wizard's server-create step populates the context; stacks
// compose these into per-stack defaults like `${service}.${DOMAIN}`.
//
//   ${SERVER_NAME}    — set by wizard, hostname of the server
//   ${DOMAIN}         — apex domain for this server (e.g. example.com)
//   ${TIMEZONE}       — IANA tz (e.g. Europe/Berlin)
//   ${PUID}/${PGID}   — container user/group IDs (linuxserver.io convention)
//   ${VOLUMES_PATH}   — host dir for compose volumes
//   ${PATH_*}         — host dirs for media libraries (PATH_MEDIA, etc.)
//
// Allow-list enforcement happens in `validateStackMeta` via
// `unsupportedReferences`. `resolveReferences` substitutes whatever is
// present in the context and leaves unknown refs alone (compose then sees
// the literal `${KEY}` and surfaces a startup error — debugging signal).

import type { VariableSpec } from "./stack-meta.ts"

/**
 * Server-level variables populated by the wizard's server-create step.
 * `PATH_*` keys are dynamic; access via the indexer.
 */
export interface ServerContext {
  SERVER_NAME: string
  DOMAIN: string
  TIMEZONE: string
  PUID: string
  PGID: string
  VOLUMES_PATH: string
  // Dynamic PATH_* keys (PATH_MEDIA, PATH_VIDEOS, etc.) — keep the
  // generic index signature for forward-compat.
  [key: `PATH_${string}`]: string
}

const SERVER_NAME_REF = "${SERVER_NAME}"
const PATH_PREFIX = "PATH_"

/**
 * Exact-match allow-list. PATH_* handled separately via prefix matching.
 * Keep this list narrow — every entry expands the v1 reference surface.
 */
const EXACT_REFS = [
  SERVER_NAME_REF,
  "${DOMAIN}",
  "${TIMEZONE}",
  "${PUID}",
  "${PGID}",
  "${VOLUMES_PATH}",
] as const

/**
 * Resolve `${KEY}` references in a string default. Looks each key up in
 * the server context; unknowns pass through unchanged so compose can
 * surface the missing var.
 */
export function resolveReferences(value: string, ctx: ServerContext): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, key: string) => {
    const v = (ctx as unknown as Record<string, unknown>)[key]
    return typeof v === "string" ? v : match
  })
}

/**
 * Detect `${...}` references in a string that are NOT in the v1 allow-list.
 * Used by `validateStackMeta` and tests to flag unsupported references early.
 * Duplicates are preserved in declaration order — caller decides whether
 * to dedupe (e.g. for user-facing error messages).
 */
export function unsupportedReferences(value: string): string[] {
  const refs = value.match(/\$\{[^}]+\}/g) ?? []
  return refs.filter((ref) => !isAllowedRef(ref))
}

function isAllowedRef(ref: string): boolean {
  if ((EXACT_REFS as readonly string[]).includes(ref)) return true
  // PATH_<NAME> — any uppercase identifier after the underscore prefix.
  if (ref.startsWith("${") && ref.includes(PATH_PREFIX)) {
    const inner = ref.slice(2, -1) // strip ${ and }
    return inner.startsWith(PATH_PREFIX) && /^[A-Z0-9_]+$/.test(inner.slice(PATH_PREFIX.length))
  }
  return false
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
 *   3. `default` if it's a string — references resolved against ctx.
 *   4. `null` — caller must prompt (or skip, per the prompt rule).
 */
export function resolveVariable(
  spec: VariableSpec,
  providedValue: string | undefined,
  ctx: ServerContext,
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
    return { value: resolveReferences(spec.default, ctx), fromDefault: true }
  }

  return null
}
