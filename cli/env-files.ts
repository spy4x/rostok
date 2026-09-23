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
 *   - a key present in both keeps its position from `existing`, value
 *     updated to `incoming`'s — so re-running with the same values is a
 *     byte-for-byte no-op, and a changed value doesn't jump to the
 *     bottom of the file (which would needlessly re-encrypt neighboring
 *     lines and churn the diff)
 *   - a key only in `existing` is preserved untouched
 *   - a key only in `incoming` is appended, in `incoming`'s order
 */
export function mergeEnv(existing: EnvEntry[], incoming: EnvEntry[]): EnvEntry[] {
  const incomingByKey = new Map(incoming.map((e) => [e.key, e.value]))
  const seen = new Set<string>()
  const out: EnvEntry[] = existing.map((e) => {
    seen.add(e.key)
    const value = incomingByKey.get(e.key)
    return value !== undefined ? { key: e.key, value } : e
  })
  for (const e of incoming) {
    if (seen.has(e.key)) continue
    seen.add(e.key)
    out.push(e)
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

/**
 * Write .env atomically: write to .tmp then rename. `.env` files hold
 * secrets — chmod both the tmp file and the final path to 0600 (owner
 * read/write only) explicitly, rather than relying only on `mode` in
 * `writeTextFile` (which only applies when the OS creates a new inode,
 * so it wouldn't tighten a `.tmp` left over with looser permissions
 * from before this fix) or on `rename` carrying the tmp file's mode
 * onto `path` (true on Linux, not guaranteed by POSIX in general).
 */
export async function writeEnvFile(path: string, entries: EnvEntry[]): Promise<void> {
  const tmp = `${path}.tmp`
  await Deno.writeTextFile(tmp, serializeEnv(entries), { mode: 0o600 })
  await Deno.chmod(tmp, 0o600)
  await Deno.rename(tmp, path)
  await Deno.chmod(path, 0o600)
}

/** Legacy remote-user keys, in fallback order (see cli/server-keys.ts SSH_USER). */
const LEGACY_USER_KEYS = ["HOMELAB_USER", "USER"] as const

/**
 * Rename a legacy remote-user key (`HOMELAB_USER`, then `USER`) to
 * `SSH_USER` in a parsed `.env`, if `SSH_USER` isn't already present.
 *
 * `USER` is what the pre-1.0.4 wizard wrote; `HOMELAB_USER` is what
 * deploy, ansible and syncthing read. `SSH_USER` replaces both — see
 * `cli/server-keys.ts`. Reading `USER` from the process environment
 * would pick up the shell's own variable, so this only ever looks at
 * the parsed file.
 */
export function migrateSshUserKey(
  entries: EnvEntry[],
): { entries: EnvEntry[]; renamedFrom?: string } {
  if (entries.some((e) => e.key === "SSH_USER")) return { entries }
  const legacyKey = LEGACY_USER_KEYS.find((k) => entries.some((e) => e.key === k))
  if (!legacyKey) return { entries }
  const out = entries.map((e) => e.key === legacyKey ? { key: "SSH_USER", value: e.value } : e)
  return { entries: out, renamedFrom: legacyKey }
}

/**
 * Build a `ServerContext` for `resolveReferences` from the parsed entries
 * of `servers/<server>/.env`. Unknown keys are not added; the resolver
 * only touches the well-known allow-list.
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
