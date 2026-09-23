// Tests for cli/env-files.ts — parse / serialize / mergeEnv.

import { assertEquals, assertRejects } from "@std/assert"
import { join } from "@std/path"
import {
  mergeEnv,
  parseEnv,
  readEnvFile,
  serializeEnv,
  serverContextFromRoot,
  writeEnvFile,
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
