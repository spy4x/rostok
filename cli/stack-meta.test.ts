// Tests for cli/stack-meta.ts — validateStackMeta + normalizeVariableSpec.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import { type } from "arktype"
import { normalizeVariableSpec, validateStackMeta } from "./stack-meta.ts"

const validStack = {
  name: "traefik",
  description: "Reverse proxy with auto-TLS",
  category: "proxy",
  variables: [
    { key: "IMAGE_TAG", default: "3.5", required: false },
    {
      key: "BASIC_AUTH_PASSWORD",
      question: "Password?",
      default: () => "x",
      required: true,
      secret: true,
    },
  ],
}

Deno.test("validateStackMeta: accepts a fully-populated stack", () => {
  const result = validateStackMeta(validStack)
  assertEquals(result.name, "traefik")
  assertEquals(result.variables.length, 2)
})

Deno.test("validateStackMeta: accepts function defaults for `default`", () => {
  const stack = {
    name: "t",
    description: "test",
    variables: [{ key: "PW", default: () => "generated" }],
  }
  const result = validateStackMeta(stack)
  assertEquals(typeof result.variables[0].default, "function")
})

Deno.test("validateStackMeta: rejects empty `key`", () => {
  const bad = { ...validStack, variables: [{ key: "" }] }
  assertThrows(() => validateStackMeta(bad), Error, "non-empty")
})

Deno.test("validateStackMeta: rejects missing `name`", () => {
  const bad = { description: "x", variables: [] }
  assertThrows(() => validateStackMeta(bad), Error)
})

Deno.test("validateStackMeta: rejects empty `description`", () => {
  const bad = { name: "x", description: "", variables: [] }
  assertThrows(() => validateStackMeta(bad), Error, "non-empty")
})

Deno.test("validateStackMeta: rejects non-string-or-function `default`", () => {
  const bad = {
    name: "t",
    description: "x",
    variables: [{ key: "X", default: 42 }],
  }
  assertThrows(() => validateStackMeta(bad), Error, "string or function")
})

Deno.test("validateStackMeta: rejects non-boolean `required`", () => {
  const bad = {
    name: "t",
    description: "x",
    variables: [{ key: "X", required: "yes" }],
  }
  assertThrows(() => validateStackMeta(bad), Error)
})

Deno.test("validateStackMeta: accepts empty `variables` array", () => {
  // A stateless stack (e.g. a pure proxy) may declare no env vars.
  const result = validateStackMeta({
    name: "t",
    description: "x",
    variables: [],
  })
  assertEquals(result.variables, [])
})

Deno.test("validateStackMeta: optional `category`", () => {
  const noCategory = validateStackMeta({
    name: "t",
    description: "x",
    variables: [],
  })
  assertEquals(noCategory.category, undefined)
})

Deno.test("normalizeVariableSpec: defaults required=true when missing", () => {
  const spec = normalizeVariableSpec({ key: "X" })
  assertEquals(spec.required, true)
})

Deno.test("normalizeVariableSpec: defaults secret=false when missing", () => {
  const spec = normalizeVariableSpec({ key: "X" })
  assertEquals(spec.secret, false)
})

Deno.test("normalizeVariableSpec: preserves explicit overrides", () => {
  const spec = normalizeVariableSpec({
    key: "X",
    required: false,
    secret: true,
  })
  assertEquals(spec.required, false)
  assertEquals(spec.secret, true)
})

Deno.test("normalizeVariableSpec: preserves default function and question", () => {
  const fn = () => "x"
  const spec = normalizeVariableSpec({
    key: "X",
    question: "Q?",
    default: fn,
  })
  assertEquals(spec.question, "Q?")
  assertEquals(spec.default, fn)
})

Deno.test("arktype smoke: narrow() with arktype 2.x API used in production", () => {
  // Sanity check that the API used by VariableSpecSchema still works —
  // catches accidental arktype major-version drift in deno.lock.
  const T = type({
    key: "string > 0",
    "default?": "unknown",
  }).narrow((v, ctx) => {
    if (
      v.default !== undefined && typeof v.default !== "string" &&
      typeof v.default !== "function"
    ) {
      return ctx.mustBe("a string or function")
    }
    return true
  })
  assertEquals(T({ key: "k", default: "x" }), { key: "k", default: "x" })
  assertEquals(T({ key: "k" }), { key: "k" })
  // arktype 2.x returns errors as values, not thrown — check the summary.
  const bad = T({ key: "k", default: 99 }) as { summary: string }
  assertEquals(typeof bad.summary, "string")
  assertStringIncludes(bad.summary, "string or function")
})
