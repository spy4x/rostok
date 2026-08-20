// Tests for cli/defaults.ts — resolveReferences, resolveVariable, unsupportedReferences.

import { assertEquals, assertStrictEquals } from "@std/assert"
import { resolveReferences, resolveVariable, unsupportedReferences } from "./defaults.ts"
import type { VariableSpec } from "./stack-meta.ts"

const mkSpec = (overrides: Partial<VariableSpec>): VariableSpec => ({
  key: "FOO",
  ...overrides,
})

Deno.test("resolveReferences: substitutes ${SERVER_NAME}", () => {
  assertEquals(resolveReferences("hello", "home"), "hello")
  assertEquals(resolveReferences("${SERVER_NAME}", "home"), "home")
  assertEquals(resolveReferences("https://${SERVER_NAME}.example", "home"), "https://home.example")
})

Deno.test("resolveReferences: handles multiple occurrences", () => {
  assertEquals(
    resolveReferences("${SERVER_NAME}-${SERVER_NAME}", "home"),
    "home-home",
  )
})

Deno.test("resolveReferences: short-circuits when no ${SERVER_NAME} present", () => {
  // Cheap path: no allocation if there's nothing to substitute.
  const value = "static.example.com"
  assertStrictEquals(resolveReferences(value, "home"), value)
})

Deno.test("resolveReferences: passes through strings with lone '$' verbatim", () => {
  // "$FOO" (no braces) isn't a supported reference — must not be touched.
  assertStrictEquals(resolveReferences("$FOO", "home"), "$FOO")
})

Deno.test("unsupportedReferences: returns empty for allowed refs", () => {
  assertEquals(unsupportedReferences("hello"), [])
  assertEquals(unsupportedReferences("${SERVER_NAME}"), [])
  assertEquals(unsupportedReferences("${SERVER_NAME}-${SERVER_NAME}"), [])
})

Deno.test("unsupportedReferences: flags unknown refs", () => {
  assertEquals(unsupportedReferences("${DOMAIN}"), ["${DOMAIN}"])
  assertEquals(
    unsupportedReferences("${SERVER_NAME}.${DOMAIN}"),
    ["${DOMAIN}"],
  )
  assertEquals(unsupportedReferences("${A}${B}${C}"), ["${A}", "${B}", "${C}"])
})

Deno.test("resolveVariable: --var override always wins (even when default exists)", () => {
  const spec = mkSpec({ default: "default-value" })
  const result = resolveVariable(spec, "from-flag", "home")
  assertEquals(result, { value: "from-flag", fromDefault: false })
})

Deno.test("resolveVariable: string default with ${SERVER_NAME} substitution", () => {
  const spec = mkSpec({ default: "${SERVER_NAME}.example.com" })
  const result = resolveVariable(spec, undefined, "home")
  assertEquals(result, { value: "home.example.com", fromDefault: true })
})

Deno.test("resolveVariable: function default called lazily", () => {
  let calls = 0
  const spec = mkSpec({
    default: () => {
      calls++
      return "generated"
    },
  })
  const result = resolveVariable(spec, undefined, "home")
  assertEquals(result, { value: "generated", fromDefault: true })
  assertEquals(calls, 1)
})

Deno.test("resolveVariable: function default returning undefined falls through to null", () => {
  const spec = mkSpec({ default: () => undefined })
  const result = resolveVariable(spec, undefined, "home")
  assertStrictEquals(result, null)
})

Deno.test("resolveVariable: no default and no --var → null (caller must prompt)", () => {
  const spec = mkSpec({})
  const result = resolveVariable(spec, undefined, "home")
  assertStrictEquals(result, null)
})

Deno.test("resolveVariable: --var empty string is still an override (not 'undefined')", () => {
  // Design decision: empty string is a valid user-provided value, distinct
  // from "no override at all". Tests this distinction.
  const spec = mkSpec({ default: "default-value" })
  const result = resolveVariable(spec, "", "home")
  assertEquals(result, { value: "", fromDefault: false })
})
