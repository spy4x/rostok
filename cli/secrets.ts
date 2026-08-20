// Cryptographically random password generator.
//
// Per docs/v1-cli.md §4 secrets:
//   - `default: () => generatePassword(N)` — `crypto.getRandomValues`, base64
//   - `secret: true` — never echoed, never logged
//
// Algorithm: Web Crypto `crypto.getRandomValues` → byte array → base64url.
// base64url uses [A-Za-z0-9_-] (64 chars) → 6 bits per symbol → high
// entropy per character. Padding stripped so the output is URL-safe and
// shell-safe without quoting.

/**
 * Generate a URL-safe random password of the requested length.
 *
 * @param length Output length in characters. Default 24 — matches the
 *               design doc's example for `BASIC_AUTH_PASSWORD`.
 * @throws RangeError when length is not a positive integer.
 */
export function generatePassword(length = 24): string {
  if (!Number.isInteger(length) || length <= 0) {
    throw new RangeError(`generatePassword length must be a positive integer, got ${length}`)
  }
  // Base64 produces 4 chars per 3 bytes; request a few extra bytes so the
  // final slice reliably lands at `length` chars regardless of encoding
  // boundaries.
  const bytes = new Uint8Array(Math.ceil(length * 0.75) + 4)
  crypto.getRandomValues(bytes)
  return toBase64Url(bytes).slice(0, length)
}

/**
 * Approximate entropy of a base64url password of `length` characters.
 * Each base64url char carries 6 bits (64-symbol alphabet).
 * Exposed for tests — verifies the generator isn't accidentally biasing
 * or truncating the output.
 */
export function passwordEntropyBits(length: number): number {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(
      `passwordEntropyBits length must be a non-negative integer, got ${length}`,
    )
  }
  return length * 6
}

function toBase64Url(bytes: Uint8Array): string {
  // btoa() needs a binary string, not Uint8Array. Build it without
  // String.fromCharCode.apply to avoid call-stack limits on large inputs.
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}
