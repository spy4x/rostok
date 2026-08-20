// Tests for cli/prompt-rule.ts — decidePrompt per docs/v1-cli.md §4.

import { assertEquals } from "@std/assert"
import { decidePrompt } from "./prompt-rule.ts"
import type { VariableSpec } from "./stack-meta.ts"

const mkSpec = (overrides: Partial<VariableSpec>): VariableSpec => ({
  key: "FOO",
  ...overrides,
})

// Spec row format: [required, hasDefault]
//   resolved is the post-resolution value from resolveVariable().
//   - undefined when no --var and no default produced a value.
//   - a string when a default (string or function) or --var produced one.

Deno.test("decidePrompt: required + no default + no --var → prompt", () => {
  assertEquals(decidePrompt(mkSpec({ required: true }), undefined), "prompt")
  assertEquals(decidePrompt(mkSpec({}), undefined), "prompt") // required defaults to true
})

Deno.test("decidePrompt: required + default → use-resolved", () => {
  assertEquals(decidePrompt(mkSpec({ required: true, default: "x" }), "x"), "use-resolved")
})

Deno.test("decidePrompt: not required + default → use-resolved", () => {
  assertEquals(decidePrompt(mkSpec({ required: false, default: "x" }), "x"), "use-resolved")
})

Deno.test("decidePrompt: not required + no default → skip (omit)", () => {
  assertEquals(decidePrompt(mkSpec({ required: false }), undefined), "skip")
})

Deno.test("decidePrompt: --var override always → use-resolved", () => {
  // Caller resolved an explicit value via --var, even on an optional var.
  assertEquals(decidePrompt(mkSpec({ required: false }), "from-flag"), "use-resolved")
})

Deno.test("decidePrompt: secret field doesn't influence decision", () => {
  // Secrets still go through the same prompt rule — they only change
  // what happens to the value after resolution (echo, log, .env age64).
  assertEquals(decidePrompt(mkSpec({ secret: true }), "x"), "use-resolved")
  assertEquals(decidePrompt(mkSpec({ secret: true }), undefined), "prompt")
})
