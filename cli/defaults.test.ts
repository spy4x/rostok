// Tests for cli/defaults.ts — resolveReferences, resolveVariable, unsupportedReferences.

import { assertEquals, assertStrictEquals } from "@std/assert"
import {
  resolveReferences,
  resolveVariable,
  type ServerContext,
  unsupportedReferences,
} from "./defaults.ts"
import type { VariableSpec } from "./stack-meta.ts"

const mkSpec = (overrides: Partial<VariableSpec>): VariableSpec => ({
  key: "FOO",
  ...overrides,
})

// Minimal context for tests. Extend as the allow-list grows.
const ctx: ServerContext = {
  SERVER_NAME: "home",
  DOMAIN: "example.com",
  TIMEZONE: "Europe/Berlin",
  PUID: "1000",
  PGID: "1000",
  VOLUMES_PATH: "/srv/volumes",
  PATH_MEDIA: "/srv/media",
  PATH_VIDEOS: "/srv/videos",
  PATH_MUSIC: "/srv/music",
}

Deno.test("resolveReferences: substitutes ${SERVER_NAME}", () => {
  assertEquals(resolveReferences("hello", ctx), "hello")
  assertEquals(resolveReferences("${SERVER_NAME}", ctx), "home")
  assertEquals(
    resolveReferences("https://${SERVER_NAME}.example", ctx),
    "https://home.example",
  )
})

Deno.test("resolveReferences: handles multiple occurrences", () => {
  assertEquals(
    resolveReferences("${SERVER_NAME}-${SERVER_NAME}", ctx),
    "home-home",
  )
})

Deno.test("resolveReferences: short-circuits when no ${KEY} present", () => {
  // Cheap path: no allocation if there's nothing to substitute.
  const value = "static.example.com"
  assertStrictEquals(resolveReferences(value, ctx), value)
})

Deno.test("resolveReferences: passes through strings with lone '$' verbatim", () => {
  // "$FOO" (no braces) isn't a supported reference — must not be touched.
  assertStrictEquals(resolveReferences("$FOO", ctx), "$FOO")
})

Deno.test("resolveReferences: substitutes ${DOMAIN}", () => {
  assertEquals(resolveReferences("${DOMAIN}", ctx), "example.com")
  assertEquals(
    resolveReferences("files.${DOMAIN}", ctx),
    "files.example.com",
  )
})

Deno.test("resolveReferences: substitutes ${TIMEZONE}, ${PUID}, ${PGID}, ${VOLUMES_PATH}", () => {
  assertEquals(resolveReferences("${TIMEZONE}", ctx), "Europe/Berlin")
  assertEquals(resolveReferences("${PUID}:${PGID}", ctx), "1000:1000")
  assertEquals(resolveReferences("${VOLUMES_PATH}", ctx), "/srv/volumes")
})

Deno.test("resolveReferences: substitutes ${PATH_*} dynamically", () => {
  assertEquals(resolveReferences("${PATH_MEDIA}", ctx), "/srv/media")
  assertEquals(resolveReferences("${PATH_VIDEOS}", ctx), "/srv/videos")
})

Deno.test("resolveReferences: unknown ${KEY} passes through unchanged", () => {
  // compose will then see the literal ${FOOBAR} and surface a startup
  // error — the debugging signal for missing context.
  assertEquals(resolveReferences("${FOOBAR}", ctx), "${FOOBAR}")
  assertEquals(
    resolveReferences("a.${FOOBAR}.b", ctx),
    "a.${FOOBAR}.b",
  )
})

Deno.test("unsupportedReferences: returns empty for allowed refs", () => {
  assertEquals(unsupportedReferences("hello"), [])
  assertEquals(unsupportedReferences("${SERVER_NAME}"), [])
  assertEquals(unsupportedReferences("${DOMAIN}"), [])
  assertEquals(unsupportedReferences("${TIMEZONE}"), [])
  assertEquals(unsupportedReferences("${PUID}"), [])
  assertEquals(unsupportedReferences("${PGID}"), [])
  assertEquals(unsupportedReferences("${VOLUMES_PATH}"), [])
  assertEquals(unsupportedReferences("${PATH_MEDIA}"), [])
  assertEquals(
    unsupportedReferences("${SERVER_NAME}.${DOMAIN}.${PATH_MEDIA}"),
    [],
  )
})

Deno.test("unsupportedReferences: flags unknown refs", () => {
  assertEquals(unsupportedReferences("${FOOBAR}"), ["${FOOBAR}"])
  assertEquals(
    unsupportedReferences("${SERVER_NAME}.${FOOBAR}"),
    ["${FOOBAR}"],
  )
  assertEquals(unsupportedReferences("${A}${B}${C}"), ["${A}", "${B}", "${C}"])
})

Deno.test("unsupportedReferences: PATH_* requires uppercase + underscore suffix", () => {
  // Valid forms:
  assertEquals(unsupportedReferences("${PATH_MEDIA}"), [])
  assertEquals(unsupportedReferences("${PATH_VIDEOS_4K}"), [])
  // Invalid forms (lowercase, no underscore, missing prefix):
  assertEquals(unsupportedReferences("${path_media}"), ["${path_media}"])
  assertEquals(unsupportedReferences("${PATHMEDIA}"), ["${PATHMEDIA}"])
  assertEquals(unsupportedReferences("${PATH_}"), ["${PATH_}"])
})

Deno.test("resolveVariable: --var override always wins (even when default exists)", () => {
  const spec = mkSpec({ default: "default-value" })
  const result = resolveVariable(spec, "from-flag", ctx)
  assertEquals(result, { value: "from-flag", fromDefault: false })
})

Deno.test("resolveVariable: string default with ${SERVER_NAME} substitution", () => {
  const spec = mkSpec({ default: "${SERVER_NAME}.example.com" })
  const result = resolveVariable(spec, undefined, ctx)
  assertEquals(result, { value: "home.example.com", fromDefault: true })
})

Deno.test("resolveVariable: string default with ${DOMAIN} substitution", () => {
  const spec = mkSpec({ default: "files.${DOMAIN}" })
  const result = resolveVariable(spec, undefined, ctx)
  assertEquals(result, { value: "files.example.com", fromDefault: true })
})

Deno.test("resolveVariable: function default called lazily", () => {
  let calls = 0
  const spec = mkSpec({
    default: () => {
      calls++
      return "generated"
    },
  })
  const result = resolveVariable(spec, undefined, ctx)
  assertEquals(result, { value: "generated", fromDefault: true })
  assertEquals(calls, 1)
})

Deno.test("resolveVariable: function default returning undefined falls through to null", () => {
  const spec = mkSpec({ default: () => undefined })
  const result = resolveVariable(spec, undefined, ctx)
  assertStrictEquals(result, null)
})

Deno.test("resolveVariable: no default and no --var → null (caller must prompt)", () => {
  const spec = mkSpec({})
  const result = resolveVariable(spec, undefined, ctx)
  assertStrictEquals(result, null)
})

Deno.test("resolveVariable: --var empty string is still an override (not 'undefined')", () => {
  // Design decision: empty string is a valid user-provided value, distinct
  // from "no override at all". Tests this distinction.
  const spec = mkSpec({ default: "default-value" })
  const result = resolveVariable(spec, "", ctx)
  assertEquals(result, { value: "", fromDefault: false })
})
