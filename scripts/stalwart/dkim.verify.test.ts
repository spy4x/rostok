// Unit tests for the pure DKIM verifier. Covers canonicalization, header
// parsing, public-key extraction, and the round-trip: generate a key pair,
// sign a test message, then verify with the same code path that will
// validate Stalwart's outbound mail.

import {
  canonicalizeBody,
  canonicalizeHeader,
  parseDkimPublicKey,
  parseDkimSignature,
  sha256Base64,
  splitMessage,
  verifyDkim,
} from "./dkim-verify.ts"
import { assert, assertEquals } from "@std/assert"

Deno.test("splitMessage handles CRLF-only message", () => {
  const raw = "From: a@example.com\r\nTo: b@example.com\r\nSubject: hi\r\n\r\nbody\r\n"
  const { headers, body } = splitMessage(raw)
  assertEquals(headers.length, 3)
  assertEquals(body, "body\r\n")
})

Deno.test("splitMessage handles LF-only message (IMAP-retrieved)", () => {
  const raw = "From: a@example.com\nTo: b@example.com\nSubject: hi\n\nbody\n"
  const { headers, body } = splitMessage(raw)
  assertEquals(headers.length, 3)
  assertEquals(body, "body\n")
})

Deno.test("splitMessage handles mixed CRLF/LF with folded continuations", () => {
  // Real IMAP servers sometimes normalise header line endings mid-stream.
  // Folded continuation lines (LF + WSP) must stay attached to their
  // parent header, regardless of what line ending preceded the fold.
  const raw = "DKIM-Signature: v=1; a=rsa-sha256; d=example.com\r\n" +
    "\th=from:to; bh=abc; b=xxx;\n" +
    "From: a@example.com\nTo: b@example.com\n\nbody\n"
  const { headers, body } = splitMessage(raw)
  // Headers = [DKIM-Signature (with continuation), From, To]
  assertEquals(headers.length, 3)
  assert(headers[0].startsWith("DKIM-Signature:"))
  // Folded continuation should be preserved in the joined header.
  assert(headers[0].includes("\th=from:to;"))
  assert(headers[0].includes("b=xxx;"))
  assertEquals(headers[1], "From: a@example.com")
  assertEquals(headers[2], "To: b@example.com")
  assertEquals(body, "body\n")
})

Deno.test("splitMessage refuses to split at folded continuation", () => {
  // `\r\n\theader` is folded continuation of the previous header, NOT a
  // header/body boundary.
  const raw = "H1: v1\r\n\tcontinuation\r\n\r\nbody\r\n"
  const { headers, body } = splitMessage(raw)
  assertEquals(headers.length, 1)
  assertEquals(headers[0], "H1: v1\r\n\tcontinuation")
  assertEquals(body, "body\r\n")
})

Deno.test("canonicalizeHeader relaxed lowercases name and trims WSP", () => {
  assertEquals(
    canonicalizeHeader("Subject", "  Hello World  ", "relaxed"),
    "subject: Hello World\r\n",
  )
  assertEquals(
    canonicalizeHeader("FROM", "a@example.com", "relaxed"),
    "from: a@example.com\r\n",
  )
})

Deno.test("canonicalizeHeader relaxed collapses internal WSP", () => {
  // Folding of `\r\n  ` (CRLF + WSP) yields the value with the WSP stripped.
  assertEquals(
    canonicalizeHeader("X-Test", "foo \r\n  bar", "relaxed"),
    "x-test: foo bar\r\n",
  )
})

Deno.test("canonicalizeHeader simple preserves case, removes fold CRLF only", () => {
  assertEquals(
    canonicalizeHeader("Subject", "Hello World", "simple"),
    "Subject:Hello World\r\n",
  )
})

Deno.test("canonicalizeBody relaxed strips trailing empty lines, reduces WSP", () => {
  // Trailing CRLFs are stripped entirely.
  assertEquals(
    canonicalizeBody("Hello world.\r\n\r\n\r\n", "relaxed"),
    "Hello world.\r\n",
  )
  // Internal WSP collapse.
  assertEquals(
    canonicalizeBody("foo   bar\r\n", "relaxed"),
    "foo bar\r\n",
  )
})

Deno.test("parseDkimSignature handles missing-semicolon edge case", () => {
  // Stalwart emits `r=y;h=...` with no separator. Parser must still find h=.
  const parsed = parseDkimSignature(
    "v=1; a=rsa-sha256; d=example.com; s=sel; h=from:to; " +
      "bh=abc; b=xxx; c=relaxed/relaxed; r=y;h=from:to;",
  )
  assertEquals(parsed.domain, "example.com")
  assertEquals(parsed.signedHeaders, ["from", "to"])
})

Deno.test("parseDkimSignature strips internal whitespace from folded values", () => {
  // Folded continuation can introduce a space inside a value (e.g. `bh=AAA\n\tBBB`
  // -> `bh=AAA BBB`). Parser must strip it.
  const parsed = parseDkimSignature(
    "v=1; a=rsa-sha256; d=example.com; s=sel; h=from; " +
      "bh=abcXXX\r\n\tYYYdef; b=z; c=relaxed/relaxed",
  )
  assertEquals(parsed.bodyHash, "abcXXXYYYdef")
})

Deno.test("parseDkimPublicKey returns null for revoked key (empty p=)", () => {
  assertEquals(parseDkimPublicKey("v=DKIM1; k=rsa; p="), null)
})

Deno.test("parseDkimPublicKey reads RSA key bytes", () => {
  const key = parseDkimPublicKey(
    "v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA",
  )
  assert(key !== null)
  assertEquals(key!.algorithm, "rsa")
  assert(key!.keyBytes.length > 0)
})

Deno.test("parseDkimPublicKey reads Ed25519 key bytes", () => {
  const key = parseDkimPublicKey(
    "v=DKIM1; k=ed25519; p=33CMZqe4Ls/aN5t24/BYKcgvLOKMsxd15ySdfaE4yhE=",
  )
  assert(key !== null)
  assertEquals(key!.algorithm, "ed25519")
  assertEquals(key!.keyBytes.length, 32)
})

// --- round-trip sign/verify with a freshly generated RSA-2048 key pair ---

function base64Encode(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function decodeSPkiToPkcs1(spki: Uint8Array): Uint8Array {
  // Strip the SPKI envelope to recover the PKCS#1 public key.
  // SPKI = SEQUENCE { AlgorithmIdentifier, BIT STRING { pkcs1 } }
  // AlgorithmIdentifier = SEQUENCE { OID, NULL } — 15 bytes for rsaEncryption.
  let off = 0
  if (spki[off++] !== 0x30) throw new Error("expected outer SEQUENCE")
  const firstLen = spki[off++]
  if (firstLen >= 0x80) off += firstLen & 0x7f
  if (spki[off++] !== 0x30) throw new Error("expected SEQUENCE for algo id")
  const algoLen = spki[off++]
  off += algoLen
  if (spki[off++] !== 0x03) throw new Error("expected BIT STRING")
  const bitLen = spki[off++]
  if (bitLen >= 0x80) off += bitLen & 0x7f // skip remaining length bytes
  off += 1 // skip the 0x00 unused-bits byte
  return spki.slice(off)
}

async function buildAndSign(
  rawHeaders: string[],
  body: string,
  signedNames: string[],
  dkimStubValue: string,
  privateKey: CryptoKey,
): Promise<{ signed: Uint8Array; bodyHash: string }> {
  const bodyHash = await sha256Base64(canonicalizeBody(body, "relaxed"))
  // Substitute the __BH__ placeholder in the stub with the real body hash so
  // the canonical input that we sign matches what the verifier will recompute.
  const stub = dkimStubValue.replace(/__BH__/, bodyHash)

  const headerParts: string[] = []
  for (const name of signedNames) {
    const h = rawHeaders.find((h) => h.toLowerCase().startsWith(name + ":"))
    if (!h) throw new Error(`missing header ${name}`)
    const colon = h.indexOf(":")
    const v = h.slice(colon + 1).replace(/\r?\n[ \t]+/g, "")
    headerParts.push(canonicalizeHeader(h.slice(0, colon), v, "relaxed"))
  }
  // DKIM-Signature with empty b= value
  const unfoldedStub = stub.replace(/\r?\n[ \t]+/g, "")
  headerParts.push(canonicalizeHeader("DKIM-Signature", unfoldedStub, "relaxed"))
  const input = headerParts.join("") + bodyHash

  const sig = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new Uint8Array(new TextEncoder().encode(input)),
  )
  return { signed: new Uint8Array(sig), bodyHash }
}

Deno.test("verifyDkim round-trip with relaxed canonicalization", async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", keyPair.publicKey),
  )
  const pkcs1 = decodeSPkiToPkcs1(spki)
  const publicKey = parseDkimPublicKey(
    `v=DKIM1; k=rsa; h=sha256; p=${base64Encode(pkcs1)}`,
  )!

  const headers = [
    "From: sender@example.com",
    "To: recipient@example.org",
    "Subject: Test DKIM",
    "Date: Mon, 25 Aug 2026 12:00:00 +0000",
    "Message-ID: <test@example.com>",
  ]
  const body = "This is a test message.\r\n"
  const dkimStub = "v=1; a=rsa-sha256; d=example.com; s=sel; " +
    "h=from:to:subject:date:message-id; bh=__BH__; b=; c=relaxed/relaxed; t=1234"
  const { signed, bodyHash } = await buildAndSign(
    headers,
    body,
    ["from", "to", "subject", "date", "message-id"],
    dkimStub,
    keyPair.privateKey,
  )
  const sigB64 = base64Encode(signed)
  const dkimHdr = "DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=sel; " +
    `h=from:to:subject:date:message-id; bh=${bodyHash}; b=${sigB64}; c=relaxed/relaxed; t=1234`
  const rawMessage = headers.join("\r\n") + "\r\n" + dkimHdr + "\r\n\r\n" + body
  const result = await verifyDkim(rawMessage, publicKey)
  assert(result.valid, `expected valid signature; reason=${result.reason}`)
})

Deno.test("verifyDkim detects body tampering", async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", keyPair.publicKey),
  )
  const publicKey = parseDkimPublicKey(
    `v=DKIM1; k=rsa; h=sha256; p=${base64Encode(decodeSPkiToPkcs1(spki))}`,
  )!

  const headers = [
    "From: a@example.com",
    "To: b@example.com",
    "Subject: s",
    "Date: Mon, 25 Aug 2026 12:00:00 +0000",
    "Message-ID: <id@example.com>",
  ]
  const body = "Original body.\r\n"
  const dkimStub = "v=1; a=rsa-sha256; d=example.com; s=sel; " +
    "h=from:to:subject:date:message-id; bh=__BH__; b=; c=relaxed/relaxed"
  const { signed, bodyHash } = await buildAndSign(
    headers,
    body,
    ["from", "to", "subject", "date", "message-id"],
    dkimStub,
    keyPair.privateKey,
  )
  const sigB64 = base64Encode(signed)
  const dkimHdr = "DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=sel; " +
    `h=from:to:subject:date:message-id; bh=${bodyHash}; b=${sigB64}; c=relaxed/relaxed`
  const raw = headers.join("\r\n") + "\r\n" + dkimHdr + "\r\n\r\n" + body
  // Tamper with body
  const tampered = raw.replace("Original body.", "Tampered body.")
  const result = await verifyDkim(tampered, publicKey)
  assert(!result.valid)
  assertEquals(result.reason, "body hash mismatch (body modified after signing)")
})

Deno.test("verifyDkim round-trip with Ed25519", async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair
  const rawPub = new Uint8Array(
    await crypto.subtle.exportKey("raw", keyPair.publicKey),
  )
  const publicKey = parseDkimPublicKey(
    `v=DKIM1; k=ed25519; p=${base64Encode(rawPub)}`,
  )!

  const headers = [
    "From: a@example.com",
    "To: b@example.com",
    "Subject: s",
    "Date: Mon, 25 Aug 2026 12:00:00 +0000",
    "Message-ID: <id@example.com>",
  ]
  const body = "Hi\r\n"
  const bh = await sha256Base64(canonicalizeBody(body, "relaxed"))

  // Build canonical input
  const { headers: hdrs } = splitMessage(headers.join("\r\n") + "\r\n\r\n" + body)
  const headerParts: string[] = []
  const signedNames = ["from", "to", "subject", "date", "message-id"]
  for (const name of signedNames) {
    const h = hdrs.find((h) => h.toLowerCase().startsWith(name + ":"))!
    const colon = h.indexOf(":")
    const v = h.slice(colon + 1).replace(/\r?\n[ \t]+/g, "")
    headerParts.push(canonicalizeHeader(h.slice(0, colon), v, "relaxed"))
  }
  const dkimRaw = "v=1; a=ed25519-sha256; d=example.com; s=sel; " +
    `h=from:to:subject:date:message-id; bh=${bh}; b=; c=relaxed/relaxed`
  const unfoldedDkim = dkimRaw.replace(/\r?\n[ \t]+/g, "")
  headerParts.push(canonicalizeHeader("DKIM-Signature", unfoldedDkim, "relaxed"))
  const input = headerParts.join("") + bh

  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    keyPair.privateKey,
    new TextEncoder().encode(input),
  )
  const sigB64 = base64Encode(new Uint8Array(sig))
  const dkimHdr = `DKIM-Signature: ${dkimRaw.replace("b=;", `b=${sigB64};`)}`
  const raw = headers.join("\r\n") + "\r\n" + dkimHdr + "\r\n\r\n" + body
  const result = await verifyDkim(raw, publicKey)
  assert(result.valid, `reason=${result.reason}`)
})

// Move import to top of file. Helper functions: removed.
