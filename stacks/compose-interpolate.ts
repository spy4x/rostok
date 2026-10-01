// Shared by the compose host-fallback tests (`domain-fallbacks*.test.ts`): renders a stack's
// compose.yml the way docker compose does, so a test can check what an `.env` without a new key
// produces. Not a test file and not part of the shipped catalog.

import { assert } from "@std/assert"

/**
 * Interpolate `${KEY}`, `${KEY:-fallback}` and `${KEY-fallback}` like docker compose, innermost
 * reference first so a fallback may hold another reference. A key missing from `env` is empty;
 * `:-` also replaces an empty value. Throws when a compose-style (upper-case) reference is still left; shell `${var}` text in a
 * command is not touched.
 */
export function interpolate(text: string, env: Record<string, string>): string {
  const ref = /\$\{([A-Z0-9_]+)(?:(:?)-([^${}]*))?\}/g
  let out = text
  for (let i = 0; i < 10 && /\$\{[A-Z0-9_]+/.test(out); i++) {
    out = out.replace(ref, (_m, key: string, colon: string | undefined, fallback?: string) => {
      const value = env[key]
      if (fallback === undefined) return value ?? ""
      return value === undefined || (colon === ":" && value === "") ? fallback : value
    })
  }
  const left = out.match(/\$\{[A-Z0-9_]+[^}]*/)
  assert(!left, `unresolved reference left in: ${left}`)
  return out
}

/** A stack's compose.yml with comment lines removed, interpolated with `env`. */
export async function renderCompose(stack: string, env: Record<string, string>): Promise<string> {
  const raw = await Deno.readTextFile(new URL(`./${stack}/compose.yml`, import.meta.url))
  const code = raw.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n")
  return interpolate(code, env)
}

/** Every `Host(...)` value in a rendered compose file, in file order. */
export function hostsIn(rendered: string): string[] {
  return [...rendered.matchAll(/Host\(`([^`]*)`\)/g)].map((m) => m[1])
}
