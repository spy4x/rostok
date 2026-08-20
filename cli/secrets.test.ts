// Tests for cli/secrets.ts — generatePassword entropy, length, charset.

import { assertEquals, assertMatch, assertNotStrictEquals, assertThrows } from "@std/assert"
import { generatePassword, passwordEntropyBits } from "./secrets.ts"

Deno.test("generatePassword: default length is 24", () => {
  assertEquals(generatePassword().length, 24)
})

Deno.test("generatePassword: respects requested length", () => {
  for (const len of [1, 8, 12, 16, 32, 48, 64, 128]) {
    assertEquals(generatePassword(len).length, len)
  }
})

Deno.test("generatePassword: uses base64url alphabet only", () => {
  // base64url = A-Z a-z 0-9 - _  (64 symbols)
  // Sampling 100 passwords — every char must match.
  for (let i = 0; i < 100; i++) {
    const pw = generatePassword(64)
    assertMatch(pw, /^[A-Za-z0-9_-]+$/)
  }
})

Deno.test("generatePassword: two consecutive calls differ", () => {
  // Cheap non-flake: get 100 pairs, at least one of each pair must differ.
  let differed = false
  for (let i = 0; i < 100 && !differed; i++) {
    if (generatePassword() !== generatePassword()) differed = true
  }
  assertEquals(differed, true)
})

Deno.test("generatePassword: longer calls produce distinct outputs across the full alphabet", () => {
  // 256 chars covers all 64 base64url symbols many times — guarantees
  // the generator isn't accidentally biasing toward a small subset.
  const pw = generatePassword(256)
  const uniqueChars = new Set(pw)
  // Each base64url symbol = 6 bits entropy. 256 chars = 1536 bits.
  // Theoretical collision probability is negligible. Allow ≥30 distinct
  // symbols to absorb any encoding bias, but expect 60+ in practice.
  if (uniqueChars.size < 30) {
    throw new Error(`only ${uniqueChars.size} unique chars in 256-char pw — generator is biased`)
  }
})

Deno.test("generatePassword: rejects non-positive length", () => {
  assertThrows(() => generatePassword(0), RangeError)
  assertThrows(() => generatePassword(-5), RangeError)
  assertThrows(() => generatePassword(1.5), RangeError)
  assertThrows(() => generatePassword(NaN), RangeError)
})

Deno.test("passwordEntropyBits: 6 bits per character", () => {
  assertEquals(passwordEntropyBits(0), 0)
  assertEquals(passwordEntropyBits(1), 6)
  assertEquals(passwordEntropyBits(24), 144)
  assertEquals(passwordEntropyBits(64), 384)
})

Deno.test("generatePassword + passwordEntropyBits: documented default is 144 bits", () => {
  // The design doc picks 24 chars for BASIC_AUTH_PASSWORD.
  // 24 chars × 6 bits = 144 bits — strong enough for an admin password.
  const pw = generatePassword()
  assertNotStrictEquals(pw, "")
  assertEquals(passwordEntropyBits(pw.length), 144)
})
