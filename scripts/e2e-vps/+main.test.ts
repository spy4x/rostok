import { assertEquals, assertMatch, assertThrows } from "@std/assert"
import { parseTarget, runIdFrom } from "./+main.ts"

Deno.test("reads `local` as this checkout and a version as JSR", () => {
  assertEquals(parseTarget(["local"]), { kind: "local" })
  assertEquals(parseTarget(["1.11.0"]), { kind: "jsr", version: "1.11.0" })
})

Deno.test("rejects a missing, unknown or extra argument with the usage text", () => {
  for (const args of [[], ["latest"], ["v1.11.0"], ["1.11"], ["local", "1.11.0"]]) {
    assertThrows(() => parseTarget(args), Error, "usage: deno task e2e:vps local | <version>")
  }
})

Deno.test("the run id is the start time, valid as a label value and in a hostname", () => {
  const id = runIdFrom(new Date("2026-10-13T09:05:07.123Z"))
  assertEquals(id, "20261013t090507z")
  assertMatch(id, /^[a-z0-9]+$/)
})
