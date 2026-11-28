import { assertEquals, assertMatch, assertNotEquals } from "@std/assert"
import { decodeBase64 } from "@std/encoding/base64"
import { generateAppKey } from "./+meta.ts"

Deno.test("solidtime: the generated APP_KEY is base64: and 32 bytes in standard base64", () => {
  const key = generateAppKey()
  assertMatch(key, /^base64:[A-Za-z0-9+/]{43}=$/)
  assertEquals(decodeBase64(key.slice("base64:".length)).length, 32)
})

Deno.test("solidtime: each generated APP_KEY is new", () => {
  assertNotEquals(generateAppKey(), generateAppKey())
})
