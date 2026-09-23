// Tests for cli/env-files.ts — parse / serialize / mergeEnv.

import { assertEquals, assertRejects } from "@std/assert"
import { join } from "@std/path"
import {
  mergeEnv,
  migrateSshUserKey,
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

// ─────────────────────────────────────────────────────────────────────
// migrateSshUserKey — #206: rename a legacy remote-user key to SSH_USER.
// ─────────────────────────────────────────────────────────────────────

Deno.test("migrateSshUserKey: renames USER to SSH_USER", () => {
  const result = migrateSshUserKey([
    { key: "PROJECT", value: "hl" },
    { key: "USER", value: "deploy" },
  ])
  assertEquals(result.renamedFrom, "USER")
  assertEquals(result.entries, [
    { key: "PROJECT", value: "hl" },
    { key: "SSH_USER", value: "deploy" },
  ])
})

Deno.test("migrateSshUserKey: renames HOMELAB_USER to SSH_USER", () => {
  const result = migrateSshUserKey([{ key: "HOMELAB_USER", value: "deploy" }])
  assertEquals(result.renamedFrom, "HOMELAB_USER")
  assertEquals(result.entries, [{ key: "SSH_USER", value: "deploy" }])
})

Deno.test("migrateSshUserKey: HOMELAB_USER wins over USER when both are present", () => {
  const result = migrateSshUserKey([
    { key: "USER", value: "from-user" },
    { key: "HOMELAB_USER", value: "from-homelab" },
  ])
  assertEquals(result.renamedFrom, "HOMELAB_USER")
  assertEquals(result.entries, [
    { key: "USER", value: "from-user" },
    { key: "SSH_USER", value: "from-homelab" },
  ])
})

Deno.test("migrateSshUserKey: no-op when SSH_USER is already present", () => {
  const entries = [{ key: "SSH_USER", value: "deploy" }, { key: "USER", value: "stale" }]
  const result = migrateSshUserKey(entries)
  assertEquals(result.renamedFrom, undefined)
  assertEquals(result.entries, entries)
})

Deno.test("migrateSshUserKey: no-op when neither legacy key is present", () => {
  const entries = [{ key: "PROJECT", value: "hl" }]
  const result = migrateSshUserKey(entries)
  assertEquals(result.renamedFrom, undefined)
  assertEquals(result.entries, entries)
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
