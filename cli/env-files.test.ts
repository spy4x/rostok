// Tests for cli/env-files.ts — parse / serialize / mergeEnv.

import { assertEquals, assertRejects, assertThrows } from "@std/assert"
import { join } from "@std/path"
import { UserError } from "./errors.ts"
import {
  decodeEnvValue,
  encodeEnvValue,
  keysWithUnsafeDollar,
  mergeEnv,
  mergeEnvPreservingFormat,
  parseEnv,
  readEnvFile,
  serializeEnv,
  serverContextFromRoot,
  writeEnvFile,
  writeEnvFilePreservingFormat,
} from "./env-files.ts"

Deno.test("parseEnv: parses key=value lines", () => {
  const text = "FOO=bar\nBAZ=qux\n# comment\n\nQUUX=1\n"
  assertEquals(parseEnv(text), [
    { key: "FOO", value: "bar" },
    { key: "BAZ", value: "qux" },
    { key: "QUUX", value: "1" },
  ])
})

Deno.test("parseEnv: skips comments and blanks", () => {
  const text = "# top comment\n\nKEY=value\n# mid comment\n\nKEY2=v2\n"
  assertEquals(parseEnv(text), [
    { key: "KEY", value: "value" },
    { key: "KEY2", value: "v2" },
  ])
})

Deno.test("parseEnv: handles '=' in value (split on first '=')", () => {
  assertEquals(parseEnv("K=a=b=c"), [{ key: "K", value: "a=b=c" }])
})

Deno.test("serializeEnv: round-trips with parseEnv", () => {
  const entries = [{ key: "A", value: "1" }, { key: "B", value: "hello world" }]
  const text = serializeEnv(entries)
  assertEquals(parseEnv(text), entries)
})

// #226: a value written with surrounding quotes keeps them, byte-identical,
// through parseEnv + serializeEnv — this module's own quoting convention
// (see the header comment). This is the round trip for the CLI's own
// read/write path; the encrypt/decrypt round trip that #226 originally
// reported the bug in is now @spy4x/server/env-age64's, outside this file.

Deno.test("parseEnv: a double-quoted value keeps its quotes (not stripped)", () => {
  assertEquals(parseEnv('KEY="has a space"\n'), [{ key: "KEY", value: '"has a space"' }])
})

Deno.test("parseEnv: a single-quoted value keeps its quotes (not stripped)", () => {
  assertEquals(parseEnv("KEY='has a space'\n"), [{ key: "KEY", value: "'has a space'" }])
})

Deno.test("serializeEnv + parseEnv: a quoted value round-trips byte-identical (#226)", () => {
  const entries = [{ key: "KEY", value: '"has a space"' }]
  const text = serializeEnv(entries)
  assertEquals(text, 'KEY="has a space"\n')
  assertEquals(parseEnv(text), entries)
})

Deno.test("mergeEnv: incoming wins on collision, preserves existing extras", () => {
  const existing = [{ key: "A", value: "old-a" }, { key: "B", value: "b-only" }]
  const incoming = [{ key: "A", value: "new-a" }, { key: "C", value: "c-new" }]
  const merged = mergeEnv(existing, incoming)
  assertEquals(merged, [
    { key: "A", value: "new-a" }, // incoming wins, but keeps A's original position
    { key: "B", value: "b-only" }, // existing-only, preserved
    { key: "C", value: "c-new" }, // incoming-only, appended
  ])
})

Deno.test("mergeEnv: an updated value stays in its original position, doesn't jump to the end", () => {
  const existing = [
    { key: "FIRST", value: "1" },
    { key: "MIDDLE", value: "old" },
    { key: "LAST", value: "3" },
  ]
  const incoming = [{ key: "MIDDLE", value: "new" }]
  assertEquals(mergeEnv(existing, incoming), [
    { key: "FIRST", value: "1" },
    { key: "MIDDLE", value: "new" },
    { key: "LAST", value: "3" },
  ])
})

Deno.test("mergeEnv: re-running with identical values is a no-op (same order, same values)", () => {
  const existing = [{ key: "A", value: "1" }, { key: "B", value: "2" }]
  assertEquals(mergeEnv(existing, existing), existing)
})

Deno.test("readEnvFile: returns [] for missing file", async () => {
  assertEquals(await readEnvFile("/nonexistent/path/.env"), [])
})

Deno.test("writeEnvFile + readEnvFile: round-trip via tmp", async () => {
  const tmp = await Deno.makeTempDir()
  const path = join(tmp, ".env")
  await writeEnvFile(path, [{ key: "K", value: "v" }])
  assertEquals(await readEnvFile(path), [{ key: "K", value: "v" }])
  await Deno.remove(tmp, { recursive: true })
})

// Security review — .env files hold secrets; they must never be
// group/world readable.

Deno.test("writeEnvFile: sets file mode 0600", async () => {
  const tmp = await Deno.makeTempDir()
  try {
    const path = join(tmp, ".env")
    await writeEnvFile(path, [{ key: "SECRET", value: "shh" }])
    const info = await Deno.stat(path)
    assertEquals((info.mode ?? 0) & 0o777, 0o600)
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("writeEnvFile: tightens permissions on rewrite of a looser-mode existing file", async () => {
  const tmp = await Deno.makeTempDir()
  try {
    const path = join(tmp, ".env")
    await Deno.writeTextFile(path, "OLD=1\n")
    await Deno.chmod(path, 0o644)
    await writeEnvFile(path, [{ key: "NEW", value: "2" }])
    const info = await Deno.stat(path)
    assertEquals((info.mode ?? 0) & 0o777, 0o600)
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("writeEnvFile: atomic via .tmp rename", async () => {
  const tmp = await Deno.makeTempDir()
  const path = join(tmp, ".env")
  await writeEnvFile(path, [{ key: "FIRST", value: "1" }])
  await writeEnvFile(path, [{ key: "SECOND", value: "2" }])
  assertEquals(await readEnvFile(path), [{ key: "SECOND", value: "2" }])
  // No .tmp leftover
  await assertRejects(async () => await Deno.stat(`${path}.tmp`))
  await Deno.remove(tmp, { recursive: true })
})

// #236 — stack add/remove and server create used to lose every comment
// and blank line on a rewrite (parseEnv/serializeEnv drop them
// outright). mergeEnvPreservingFormat/writeEnvFilePreservingFormat
// operate on the raw text instead, so hand-written annotations survive.

Deno.test("mergeEnvPreservingFormat: keeps comments and blank lines, updates a known key in place, appends a new one", () => {
  const existingText = [
    "# server-level settings",
    "DOMAIN=example.com",
    "",
    "# stack: librespeed",
    "LIBRESPEED_DOMAIN=speedtest.example.com",
    "LIBRESPEED_CPU_LIMIT=0.5",
  ].join("\n") + "\n"
  const out = mergeEnvPreservingFormat(existingText, [
    { key: "LIBRESPEED_CPU_LIMIT", value: "1.0" }, // changed
    { key: "LIBRESPEED_MEM_LIMIT", value: "256M" }, // new — appended, no blank separator added
  ])
  assertEquals(
    out,
    [
      "# server-level settings",
      "DOMAIN=example.com",
      "",
      "# stack: librespeed",
      "LIBRESPEED_DOMAIN=speedtest.example.com",
      "LIBRESPEED_CPU_LIMIT=1.0",
      "LIBRESPEED_MEM_LIMIT=256M",
    ].join("\n") + "\n",
  )
})

Deno.test("mergeEnvPreservingFormat: removeKeys drops only that key's line, comments around it survive", () => {
  const existingText = [
    "# kept",
    "DOMAIN=example.com",
    "# librespeed's own values",
    "LIBRESPEED_DOMAIN=speedtest.example.com",
    "LIBRESPEED_CPU_LIMIT=0.5",
  ].join("\n") + "\n"
  const out = mergeEnvPreservingFormat(existingText, [], new Set(["LIBRESPEED_DOMAIN"]))
  assertEquals(
    out,
    [
      "# kept",
      "DOMAIN=example.com",
      "# librespeed's own values",
      "LIBRESPEED_CPU_LIMIT=0.5",
      "",
    ].join("\n"),
  )
})

Deno.test("mergeEnvPreservingFormat: no changes round-trips byte-identical", () => {
  const existingText = "# a note\nFOO=bar\n\nBAZ=qux\n"
  assertEquals(mergeEnvPreservingFormat(existingText, []), existingText)
})

Deno.test("writeEnvFilePreservingFormat: rewrites .env on disk, keeping its comments", async () => {
  const tmp = await Deno.makeTempDir()
  const path = join(tmp, ".env")
  try {
    await Deno.writeTextFile(path, "# annotate this\nFOO=bar\n\nBAZ=qux\n")
    await writeEnvFilePreservingFormat(path, [{ key: "FOO", value: "changed" }])
    const text = await Deno.readTextFile(path)
    assertEquals(text, "# annotate this\nFOO=changed\n\nBAZ=qux\n")
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("writeEnvFilePreservingFormat: missing file — writes only the incoming entries", async () => {
  const tmp = await Deno.makeTempDir()
  const path = join(tmp, ".env")
  try {
    await writeEnvFilePreservingFormat(path, [{ key: "FOO", value: "bar" }])
    assertEquals(await Deno.readTextFile(path), "FOO=bar\n")
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("serverContextFromRoot: produces a usable ServerContext shape", () => {
  const ctx = serverContextFromRoot([
    { key: "SERVER_NAME", value: "home" },
    { key: "DOMAIN", value: "example.com" },
    { key: "TIMEZONE", value: "Europe/Berlin" },
    { key: "PUID", value: "1000" },
    { key: "PGID", value: "1000" },
    { key: "VOLUMES_PATH", value: "/srv/volumes" },
    { key: "PATH_MEDIA", value: "/srv/media" },
    { key: "EXTRA_NOISE", value: "ignored-but-present" },
  ])
  assertEquals(ctx.SERVER_NAME, "home")
  assertEquals(ctx.DOMAIN, "example.com")
  assertEquals(ctx.PATH_MEDIA, "/srv/media")
  // EXTRA_NOISE is on the type but ignored by resolveReferences — the
  // ServerContext indexer signature accepts arbitrary keys.
})

// ─────────────────────────────────────────────────────────────────────
// #313 — a `$` in a value must reach compose and hooks literally.
// ─────────────────────────────────────────────────────────────────────

Deno.test("encodeEnvValue: single-quotes a new value that contains $", () => {
  assertEquals(encodeEnvValue("PW", "p$ssw0rd"), "'p$ssw0rd'")
  assertEquals(encodeEnvValue("PW", "a$${b}$"), "'a$${b}$'")
})

Deno.test("encodeEnvValue: leaves a value without $ untouched, quotes included", () => {
  assertEquals(encodeEnvValue("PW", "plain"), "plain")
  assertEquals(encodeEnvValue("PW", '"has a space"'), '"has a space"')
  assertEquals(encodeEnvValue("PW", "it's"), "it's")
})

Deno.test("encodeEnvValue: keeps an already single-quoted $ value as it is", () => {
  assertEquals(encodeEnvValue("PW", "'p$ss'"), "'p$ss'")
})

Deno.test("encodeEnvValue: re-quotes a plain double-quoted $ value with single quotes", () => {
  assertEquals(encodeEnvValue("PW", '"p$ss"'), "'p$ss'")
})

Deno.test("encodeEnvValue: refuses a value with both $ and ', naming the key but not the value", () => {
  const error = assertThrows(() => encodeEnvValue("MY_PW", "it's$ecret"), UserError)
  assertEquals(error.message.startsWith("MY_PW:"), true)
  assertEquals(error.message.includes("ecret"), false)
})

Deno.test("decodeEnvValue: reads a value the way docker compose does", () => {
  assertEquals(decodeEnvValue("'p$ssw0rd'"), "p$ssw0rd")
  assertEquals(decodeEnvValue("'p$$ssw0rd'"), "p$$ssw0rd")
  assertEquals(decodeEnvValue("p$$ssw0rd"), "p$ssw0rd")
  assertEquals(decodeEnvValue('"p$$ssw0rd"'), "p$ssw0rd")
  assertEquals(decodeEnvValue("plain"), "plain")
})

Deno.test("decodeEnvValue: undoes encodeEnvValue for any value it accepts", () => {
  for (const value of ["p$ssw0rd", "$", "a$$b", "${X}", "no-dollar", '"quoted"']) {
    const expected = value.includes("$") ? value : decodeEnvValue(value)
    assertEquals(decodeEnvValue(encodeEnvValue("K", value)), expected)
  }
})

Deno.test("keysWithUnsafeDollar: reports a bare $name compose would warn about", () => {
  assertEquals(keysWithUnsafeDollar({ A: "p$ssw0rd", B: "fine", C: '"x$y"' }), ["A", "C"])
})

Deno.test("keysWithUnsafeDollar: a reference to a key of an earlier file is known", () => {
  assertEquals(keysWithUnsafeDollar({ HOST: "mail.${DOMAIN}" }, { DOMAIN: "example.com" }), [])
  assertEquals(keysWithUnsafeDollar({ HOST: "mail.${DOMAIN}" }), ["HOST"])
})

Deno.test("keysWithUnsafeDollar: reports an unknown or broken ${...} template", () => {
  assertEquals(
    keysWithUnsafeDollar({
      A: "a${b",
      B: "a${X:-q}",
      C: "a${UNKNOWN}",
      D: "a${}",
      // Unclosed, though `A` is a key: compose prints the whole value.
      E: "x${A",
      // Malformed single quotes: compose's error quotes the rest.
      F: "'ab'c$def",
      // Malformed double quotes: the same, compose quotes the rest.
      G: '"ab"$cd',
      H: '"ab"c$d',
    }),
    ["A", "B", "C", "D", "E", "F", "G", "H"],
  )
})

Deno.test("keysWithUnsafeDollar: accepts single quotes, $$ escapes, literal $, comments and known references", () => {
  assertEquals(
    keysWithUnsafeDollar({
      PATH_APPS: "/srv/apps",
      VOLUMES_PATH: "${PATH_APPS}/../volumes",
      OTHER: "$PATH_APPS",
      QUOTED: "'p$ssw0rd'",
      QUOTED_COMMENT_SQ: "'p$ss' # note",
      ESCAPED: "p$$ssw0rd",
      ESCAPED_QUOTED: '"p$$ssw0rd"',
      QUOTED_COMMENT_DQ: '"ab" # c$d',
      LITERAL: "a$ b$1 c$! d$",
      COMMENT: "value # see $ZZZ_X",
      QUOTED_COMMENT: '"q$$x" # $YYY',
    }),
    [],
  )
})
