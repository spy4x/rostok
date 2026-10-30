// Shared by the compose host-fallback tests (`domain-fallbacks*.test.ts`): renders a stack's
// compose.yml the way docker compose does, so a test can check what an `.env` without a new key
// produces. Not a test file and not part of the shipped catalog.

import { assert } from "@std/assert"

/**
 * Interpolate `${KEY}`, `${KEY:-fallback}`, `${KEY-fallback}`, `${KEY:+alternate}` and
 * `${KEY+alternate}` like docker compose, innermost reference first so a fallback or alternate may
 * hold another reference. A key missing from `env` is empty; `:-` also replaces an empty value,
 * and `:+` gives its alternate only for a non-empty one. A required reference, `${KEY:?}` or `${KEY?}`, throws when
 * the key is missing (with `:`, also when it is empty), as compose refuses to run then. Throws
 * when a compose-style (upper-case) reference is still left; shell `${var}` text in a command is
 * not touched.
 */
export function interpolate(text: string, env: Record<string, string>): string {
  const ref = /\$\{([A-Z0-9_]+)(?:(:?)([-+])([^${}]*))?\}/g
  const required = /\$\{([A-Z0-9_]+)(:?)\?[^${}]*\}/g
  let out = text.replace(required, (_m, key: string, colon: string) => {
    const value = env[key]
    if (value === undefined || (colon === ":" && value === "")) {
      throw new Error(`required variable ${key} is missing a value`)
    }
    return value
  })
  for (let i = 0; i < 10 && /\$\{[A-Z0-9_]+/.test(out); i++) {
    out = out.replace(ref, (_m, key: string, colon?: string, op?: string, word?: string) => {
      const value = env[key]
      if (word === undefined) return value ?? ""
      const unset = value === undefined || (colon === ":" && value === "")
      if (op === "+") return unset ? "" : word
      return unset ? word : value
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
