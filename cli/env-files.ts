// .env file read/write helpers.
//
// Format: `KEY=value` per line. Lines starting with `#` are comments.
// Empty lines ignored.
//
// Quoting convention (#226): a value's surrounding quotes (`'...'` or
// `"..."`, one layer) are part of the value, verbatim, AS FAR AS THIS
// FILE AND THE TRACKED .env/.env.age GO — parseEnv/serializeEnv never
// strip or add them. `KEY="has a space"` parses to `value:
// '"has a space"'`, quotes included, and serializes back
// byte-identical. That is deliberately NOT what a container ends up
// seeing: docker compose's `env_file` and Deno's `--env-file` each
// strip exactly one matching layer of quotes when they load a `.env`
// (verified directly: `docker compose config` turns `FOO="has a
// space"` into the environment value `has a space`, no quotes; `deno
// --env-file` does the same for `Deno.env.get`) — and both go further
// still, turning `\n` inside double quotes into a real newline and
// dropping a trailing ` # comment` from an unquoted value. A hook
// process launched by `cli/deploy/hooks.ts` only gets the one-quote-
// layer strip (`stripOneQuoteLayer` — see `buildHookEnv`'s own
// comment), not the escape/comment handling, so a hook can see a
// different value than its container for those two forms. This file's
// job is only to keep the FILE ROUND TRIP (read a `.env`, write it
// back, or re-encrypt it) byte-identical; it is not the place that
// mimics compose's or a hook's runtime stripping.
//
// The CLI never adds quotes; it writes a value verbatim as supplied by
// stack defaults, --var flags, or interactive prompts — a value that
// needs quoting to survive some other consumer's parser must be typed
// with the quotes already included. Stacks that need multi-line values
// compose them in shell, not in .env.
//
// This module's own round trip already preserves quotes byte-identical
// (see env-files.test.ts) — it never had the bug #226 reported. The
// actual quote-stripping bug was in `cli/age.ts`'s `parseEnvFile` (used
// by the real `rostok env encrypt`/`decrypt` path, not this file), which
// stripped one layer of matching quotes on read and never restored it on
// write — fixed there, with its own test.

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
 * Write text to `path` atomically: write to .tmp then rename. `.env`
 * files hold secrets — chmod both the tmp file and the final path to
 * 0600 (owner read/write only) explicitly, rather than relying only on
 * `mode` in `writeTextFile` (which only applies when the OS creates a
 * new inode, so it wouldn't tighten a `.tmp` left over with looser
 * permissions from before this fix) or on `rename` carrying the tmp
 * file's mode onto `path` (true on Linux, not guaranteed by POSIX in
 * general).
 */
async function writeFileAtomic0600(path: string, text: string): Promise<void> {
  const tmp = `${path}.tmp`
  await Deno.writeTextFile(tmp, text, { mode: 0o600 })
  await Deno.chmod(tmp, 0o600)
  await Deno.rename(tmp, path)
  await Deno.chmod(path, 0o600)
}

/** Write .env atomically — see {@link writeFileAtomic0600}. Drops comments/blank lines; see {@link writeEnvFilePreservingFormat} for a rewrite that keeps them. */
export async function writeEnvFile(path: string, entries: EnvEntry[]): Promise<void> {
  await writeFileAtomic0600(path, serializeEnv(entries))
}

// ─────────────────────────────────────────────────────────────────────
// #236 — stack add/remove and server create used to round-trip through
// `readEnvFile`/`mergeEnv`/`writeEnvFile` above, which parse away every
// comment and blank line (see the module comment: "Comments and blanks
// ... ignored") and never put them back. A hand-annotated `.env` (a
// comment explaining a value, a blank line grouping related keys) lost
// all of that on the next `stack add`. `mergeEnvPreservingFormat` /
// `writeEnvFilePreservingFormat` below operate on the RAW existing text
// instead: known keys are updated or removed in place, comments and
// blank lines are left exactly where they were, and only genuinely new
// keys are appended. `EnvEntry`, `parseEnv`, `mergeEnv`, `readEnvFile`
// and plain `writeEnvFile` above are untouched — `cli/deploy/run-deploy.ts`
// and other readers still get plain key/value pairs, nothing about their
// shape changes.
// ─────────────────────────────────────────────────────────────────────

/** One line of a `.env` file, in original order: either a parsed key/value pair, or a comment/blank line kept verbatim. */
type EnvLine = { kind: "kv"; key: string; value: string } | { kind: "raw"; text: string }

/**
 * Like `parseEnv`, but keeps comments and blank lines as `raw` entries
 * instead of discarding them, so a caller can reconstruct the file with
 * only the intended keys changed.
 */
function parseEnvLines(text: string): EnvLine[] {
  const rawLines = text.split("\n")
  // A file written by `writeFileAtomic0600`/serializeEnv* always ends in
  // exactly one trailing "\n" — split() turns that into one trailing ""
  // element that isn't a real blank line in the file. Drop it here so
  // round-tripping unchanged text doesn't grow a blank line every write.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop()

  const lines: EnvLine[] = []
  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      lines.push({ kind: "raw", text: rawLine })
      continue
    }
    const eq = rawLine.indexOf("=")
    if (eq < 0) {
      lines.push({ kind: "raw", text: rawLine })
      continue
    }
    lines.push({ kind: "kv", key: rawLine.slice(0, eq).trim(), value: rawLine.slice(eq + 1) })
  }
  return lines
}

function serializeEnvLines(lines: EnvLine[]): string {
  return lines.map((l) => (l.kind === "kv" ? `${l.key}=${l.value}` : l.text)).join("\n") + "\n"
}

/**
 * Apply `incoming` (update-or-append, like `mergeEnv`) and `removeKeys`
 * (drop the line entirely) to `existingText`, keeping every comment,
 * blank line, and untouched key/value line exactly where it was. A key
 * in both `incoming` and `removeKeys` is removed — `removeKeys` wins,
 * since a caller asking to drop a key is stronger intent than a default
 * value that happened to be passed alongside it.
 */
export function mergeEnvPreservingFormat(
  existingText: string,
  incoming: EnvEntry[],
  removeKeys: ReadonlySet<string> = new Set(),
): string {
  const existingLines = parseEnvLines(existingText)
  const incomingByKey = new Map(incoming.map((e) => [e.key, e.value]))
  const seen = new Set<string>()

  const out: EnvLine[] = []
  for (const line of existingLines) {
    if (line.kind === "raw") {
      out.push(line)
      continue
    }
    seen.add(line.key)
    if (removeKeys.has(line.key)) continue
    const value = incomingByKey.get(line.key)
    out.push(value !== undefined ? { kind: "kv", key: line.key, value } : line)
  }
  for (const e of incoming) {
    if (seen.has(e.key) || removeKeys.has(e.key)) continue
    seen.add(e.key)
    out.push({ kind: "kv", key: e.key, value: e.value })
  }
  return serializeEnvLines(out)
}

/**
 * Rewrite `.env` at `path`, preserving comments/blank lines/order —
 * see {@link mergeEnvPreservingFormat}. Reads the CURRENT file text
 * itself (not a previously-parsed `EnvEntry[]`, which has already lost
 * that formatting) so it always merges against exactly what's on disk.
 */
export async function writeEnvFilePreservingFormat(
  path: string,
  incoming: EnvEntry[],
  removeKeys: ReadonlySet<string> = new Set(),
): Promise<void> {
  let existingText = ""
  try {
    existingText = await Deno.readTextFile(path)
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err
  }
  await writeFileAtomic0600(path, mergeEnvPreservingFormat(existingText, incoming, removeKeys))
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
