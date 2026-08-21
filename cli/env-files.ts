// .env file read/write helpers.
//
// Format: `KEY=value` per line. Lines starting with `#` are comments.
// Empty lines ignored. No quoting/escaping rules beyond plain text values
// (matches what scripts/encryption/encrypt.ts produces and consumes).
//
// The CLI never quotes values; it writes them verbatim as supplied by
// stack defaults, --var flags, or interactive prompts. Stacks that need
// multi-line values compose them in shell, not in .env.

import { dirname, join } from "@std/path"

export interface EnvEntry {
  key: string
  value: string
}

/** Parse a `.env` string into key/value pairs. Preserves order. */
export function parseEnv(text: string): EnvEntry[] {
  const entries: EnvEntry[] = []
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1)
    entries.push({ key, value })
  }
  return entries
}

/** Serialize a list of entries to .env text. One entry per line, no comments. */
export function serializeEnv(entries: EnvEntry[]): string {
  return entries.map((e) => `${e.key}=${e.value}`).join("\n") + "\n"
}

/**
 * Merge `incoming` into `existing`:
 *   - keys in `incoming` overwrite keys in `existing`
 *   - keys in `existing` not in `incoming` are preserved
 * Order: incoming wins on collision; existing keys come first, then any
 * incoming-only keys appended.
 */
export function mergeEnv(existing: EnvEntry[], incoming: EnvEntry[]): EnvEntry[] {
  const out: EnvEntry[] = []
  const seen = new Set<string>()
  for (const e of existing) {
    if (incoming.some((i) => i.key === e.key)) {
      // skip — will be replaced by the incoming entry
      continue
    }
    out.push(e)
    seen.add(e.key)
  }
  // Preserve order of incoming, then append any extras not yet seen.
  for (const e of incoming) {
    out.push(e)
    seen.add(e.key)
  }
  return out
}

/** Read .env from disk; return [] if missing or empty. */
export async function readEnvFile(path: string): Promise<EnvEntry[]> {
  try {
    const text = await Deno.readTextFile(path)
    return parseEnv(text)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return []
    throw err
  }
}

/** Write .env atomically: write to .tmp then rename. */
export async function writeEnvFile(path: string, entries: EnvEntry[]): Promise<void> {
  const tmp = `${path}.tmp`
  await Deno.writeTextFile(tmp, serializeEnv(entries))
  await Deno.rename(tmp, path)
}

/**
 * Build a `ServerContext` for `resolveReferences` from the parsed entries
 * of `.env.root`. Unknown keys are not added; the resolver only touches
 * the well-known allow-list.
 */
export function serverContextFromRoot(entries: EnvEntry[]) {
  const out: Record<string, string> = {}
  for (const { key, value } of entries) {
    out[key] = value
  }
  return out as {
    SERVER_NAME: string
    DOMAIN: string
    TIMEZONE: string
    PUID: string
    PGID: string
    VOLUMES_PATH: string
    [key: `PATH_${string}`]: string
  }
}

export { dirname, join }
