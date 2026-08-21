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
    { key: "B", value: "b-only" }, // existing-only, preserved
    { key: "A", value: "new-a" }, // incoming wins, kept in incoming order
    { key: "C", value: "c-new" }, // incoming-only
  ])
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
