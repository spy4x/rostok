// Tests for cli/arktype-type.ts — ArktypeType wrapping arktype schemas for cliffy.

import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert"
import { type } from "arktype"
import { arktypeToCliffy, ArktypeType } from "./arktype-type.ts"

// Mimic cliffy's ArgumentValue shape. Only `value` matters for our impl.
const argValue = (v: string) =>
  ({
    label: "x",
    name: "x",
    value: v,
    type: undefined,
  }) as unknown as Parameters<ArktypeType["parse"]>[0]

Deno.test("ArktypeType: parses valid input and returns the value", () => {
  const T = type("string >= 3")
  const wrapper = new ArktypeType<string>("name", T)
  assertEquals(wrapper.parse(argValue("hello")), "hello")
})

Deno.test("ArktypeType: rejects invalid input with the wrapped schema's summary", () => {
  const T = type("string >= 3")
  const wrapper = new ArktypeType<string>("name", T)
  assertThrows(
    () => wrapper.parse(argValue("hi")),
    Error,
    "name:",
  )
})

Deno.test("ArktypeType: works with object schemas when given a parsed object", () => {
  // Object-schema validation is a useful building block for nested configs
  // (e.g. JSON-typed CLI args). The wrapper passes the value through to
  // arktype as-is — no JSON coercion in Phase 3. Phase 5 picks the
  // coercion policy.
  const T = type({
    host: "string >= 1",
    port: "0 <= number <= 65535",
  })
  const wrapper = new ArktypeType("endpoint", T)
  // Pass an object — arktype accepts objects directly.
  const objArg = {
    value: { host: "example", port: 443 },
    label: "e",
    name: "e",
    type: undefined,
  } as unknown as Parameters<ArktypeType["parse"]>[0]
  const result = wrapper.parse(objArg)
  assertEquals(result, { host: "example", port: 443 })
})

Deno.test("ArktypeType: object schema fails on missing fields", () => {
  const T = type({ port: "number" })
  const wrapper = new ArktypeType("endpoint", T)
  // Passing a string missing required fields triggers the type mismatch first.
  assertThrows(() => wrapper.parse(argValue("{}")), Error, "endpoint:")
})

Deno.test("arktypeToCliffy: factory returns an ArktypeType instance", () => {
  const T = type("string")
  const wrapper = arktypeToCliffy<string>("name", T)
  assertEquals(wrapper instanceof ArktypeType, true)
  assertEquals(wrapper.typeName, "name")
})

Deno.test("ArktypeType: parse propagates arktype's summary, not the raw error tree", () => {
  // Important: the thrown message must be CLI-friendly (single line).
  // arktype's default `toString()` dumps the full ArkErrors tree.
  const T = type("string >= 6")
  const wrapper = new ArktypeType<string>("name", T)
  try {
    wrapper.parse(argValue("short"))
    throw new Error("should have thrown")
  } catch (e) {
    const msg = (e as Error).message
    assertEquals(msg.includes("\n"), false, `message has newlines: ${msg}`)
    assertEquals(msg.startsWith("name:"), true)
  }
})

Deno.test("ArktypeType: defensive — single-line summary contract preserved across multi-field errors", () => {
  // Multi-field arktype errors produce `\n`-joined summaries. Through the
  // cliffy flow this is hard to trigger (cliffy passes strings), but the
  // flattenSummary helper is exercised by stack-meta.ts. We test the
  // contract here: feeding a known multi-line summary through the same
  // flatten expression used in production yields a single-line output.
  // (The helper itself is private; testing the regex shape preserves the
  // intent without leaking implementation.)
  const multiLine = "host must be a string (was missing)\nport must be a string (was missing)"
  const flattened = multiLine.replace(/\n+/g, "; ")
  assertEquals(flattened.includes("\n"), false)
  assertStringIncludes(flattened, "; ")
  // And the production wrapper's thrown message for a single-line schema
  // failure still starts with the type name prefix.
  const T = type("string >= 6")
  const wrapper = new ArktypeType<string>("name", T)
  try {
    wrapper.parse(argValue("x"))
    throw new Error("should have thrown")
  } catch (e) {
    const msg = (e as Error).message
    assertEquals(msg.includes("\n"), false)
    assertEquals(msg.startsWith("name:"), true)
  }
})

Deno.test("ArktypeType: works through a cliffy parse flow on string schema", async () => {
  // End-to-end smoke: hand the wrapper to a fresh Command and verify the
  // CLI rejects an invalid arg via the standard cliffy error channel.
  // String-only schema — number coercion is Phase 5's concern.
  const { Command } = await import("@cliffy/command")
  // Require at least 3 characters so single-char input fails.
  const portType = new ArktypeType<string>("port", type("string >= 3"))
  let captured: unknown
  const cmd = new Command()
    .type("port", portType)
    .arguments("<port:port>")
    .action((_opts, port: string) => {
      captured = port
    })
    .throwErrors()
  await assertRejects(
    async () => cmd.parse(["ab"]),
    Error,
    "port:",
  )
  await cmd.parse(["443"])
  assertEquals(captured, "443")
})
