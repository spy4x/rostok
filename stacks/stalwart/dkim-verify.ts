// DKIM signature verification per RFC 6376.
// Pure verifier — takes a raw RFC822 message and a DKIM public key,
// returns whether the signature is valid against that key.
//
// Used by the stalwart post-deploy investigation (see #141) to test
// outbound messages offline. Public key can come from DNS TXT or be
// supplied directly for tests.

export type Canonicalization = "simple" | "relaxed"
export type DkimAlgorithm = "rsa-sha256" | "ed25519-sha256"

export interface DkimSignatureHeader {
  version: string
  algorithm: DkimAlgorithm
  domain: string
  selector: string
  signedHeaders: string[]
  bodyHash: string
  signature: string
  canonicalization: { header: Canonicalization; body: Canonicalization }
  timestamp?: bigint
  expiration?: bigint
  queryMethod?: string
  identity?: string
  raw: string
}

export interface DkimPublicKey {
  /** "rsa" or "ed25519" */
  algorithm: "rsa" | "ed25519"
  /** The public key in binary form (after base64-decoding the p= field) */
  keyBytes: Uint8Array
}

export interface DkimVerificationResult {
  valid: boolean
  reason?: string
  parsed?: DkimSignatureHeader
  /** What the recomputed body hash was, for diagnostics */
  computedBodyHash?: string
  /** What the recomputed signature input was, for diagnostics */
  computedInputPreview?: string
}

export class DkimParseError extends Error {
  override name = "DkimParseError"
}

/**
 * Parse a `DKIM-Signature:` header value (without the leading `DKIM-Signature:`
 * text) into structured form. Tag values may contain FWS (RFC 5322 folding
 * whitespace); this function collapses that to a single space.
 */
export function parseDkimSignature(raw: string): DkimSignatureHeader {
  // Collapse header folding: either CRLF or LF followed by WSP -> single SP.
  // Real-world messages sometimes carry only LF after intermediate storage
  // (IMAP servers, mailbox files) even though RFC 5322 mandates CRLF.
  const collapsed = raw.replace(/\r?\n[ \t]+/g, " ")
  const tags = new Map<string, string>()
  // tag=value pairs where value may be quoted or unquoted. The boundary
  // before each tag is either start-of-string or after a `;` (with optional
  // whitespace); without that anchor the regex eats the `b` of `bh=`.
  const re = /(?:^|;)\s*([a-z]+)=(?:"([^"]*)"|([^;]*))/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(collapsed)) !== null) {
    const name = match[1].toLowerCase()
    // Strip all whitespace — folding collapse can leave spaces mid-value
    // (e.g. `bh=AAA\n\tBBB` -> `bh=AAA BBB`).
    const value = (match[2] ?? match[3] ?? "").replace(/\s+/g, "")
    tags.set(name, value)
  }

  const required = ["v", "a", "d", "s", "h", "bh", "b", "c"]
  for (const tag of required) {
    if (!tags.has(tag)) {
      throw new DkimParseError(`DKIM-Signature missing required tag: ${tag}`)
    }
  }

  const canonicalization = parseCanonicalization(tags.get("c")!)
  const algorithm = parseAlgorithm(tags.get("a")!)
  const signedHeaders = tags.get("h")!.split(":").map((h) => h.trim().toLowerCase()).filter(
    Boolean,
  )
  if (!signedHeaders.length) {
    throw new DkimParseError("DKIM-Signature h= tag has no headers")
  }

  return {
    version: tags.get("v")!,
    algorithm,
    domain: tags.get("d")!.toLowerCase(),
    selector: tags.get("s")!.toLowerCase(),
    signedHeaders,
    bodyHash: tags.get("bh")!,
    signature: tags.get("b")!,
    canonicalization,
    timestamp: tags.has("t") ? BigInt(tags.get("t")!) : undefined,
    expiration: tags.has("x") ? BigInt(tags.get("x")!) : undefined,
    queryMethod: tags.get("q"),
    identity: tags.get("i"),
    raw,
  }
}

function parseCanonicalization(value: string): DkimSignatureHeader["canonicalization"] {
  // c=<header>/<body>, either or both may appear.
  const [header = "simple", body = "simple"] = value.toLowerCase().split("/")
  if (header !== "simple" && header !== "relaxed") {
    throw new DkimParseError(`unsupported header canonicalization: ${header}`)
  }
  if (body !== "simple" && body !== "relaxed") {
    throw new DkimParseError(`unsupported body canonicalization: ${body}`)
  }
  return { header, body }
}

function parseAlgorithm(value: string): DkimAlgorithm {
  const normalized = value.toLowerCase()
  if (normalized !== "rsa-sha256" && normalized !== "ed25519-sha256") {
    throw new DkimParseError(`unsupported DKIM algorithm: ${value}`)
  }
  return normalized
}

/**
 * Canonicalize a single header per RFC 6376 §3.4 (relaxed or simple).
 * Returns the FULL header line (name ": " value), terminated with CRLF.
 * The colon-and-SP separator is canonical: relaxed uses ": ", simple uses ":".
 */
export function canonicalizeHeader(
  name: string,
  value: string,
  algorithm: Canonicalization,
): string {
  if (algorithm === "relaxed") {
    // 1. Convert header name to lowercase
    // 2. Unfold all header continuation lines (CRLF before WSP -> nothing)
    // 3. Convert all sequences of WSP to a single SP
    // 4. Delete all WSP at end of each header value
    // 5. Delete WSP before/after the colon separator
    const unfolded = value.replace(/\r\n[ \t]+/g, "")
    const collapsed = unfolded.replace(/[ \t]+/g, " ").replace(/[ \t]+$/, "").replace(/^[ \t]+/, "")
    return `${name.toLowerCase()}: ${collapsed}\r\n`
  }
  // "simple" canonicalization preserves header name case, leaves the value
  // except for collapsing the fold CRLF + WSP into a single WSP.
  const unfolded = value.replace(/\r\n[ \t]+/g, " ")
  return `${name}:${unfolded}\r\n`
}

/**
 * Canonicalize a message body per RFC 6376 §3.4.
 * Empty lines at the end of the body are ignored; in relaxed form, internal
 * sequences of WSP are reduced to a single SP.
 */
export function canonicalizeBody(
  body: string,
  algorithm: Canonicalization,
): string {
  // Strip trailing CRLFs entirely; the canonical body ends with CRLF if any
  // content remains, or is empty if the original body was empty.
  const stripped = body.replace(/(\r\n)+$/, "")
  if (algorithm === "simple") return stripped + "\r\n"
  // Relaxed body: reduce sequences of WSP to a single SP.
  // The trailing CRLF after stripping is implicit (per spec the body
  // terminates with CRLF if not empty).
  const reduced = stripped.replace(/[ \t]+/g, " ").replace(/[ \t]+\r\n/g, "\r\n")
  return reduced + "\r\n"
}

/**
 * Parse a DKIM TXT record's `p=` field into a public key.
 * The TXT record must already be normalized (whitespace collapsed,
 * quotes stripped). Returns null if the key is revoked (`p=` is empty).
 */
export function parseDkimPublicKey(txtRecord: string): DkimPublicKey | null {
  const tags = new Map<string, string>()
  const re = /([a-z])=([^;]+)/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(txtRecord)) !== null) {
    tags.set(match[1].toLowerCase(), match[2].trim())
  }
  const p = tags.get("p")
  if (!p || p === "") return null
  const algorithm = (tags.get("k") ?? "rsa").toLowerCase()
  if (algorithm !== "rsa" && algorithm !== "ed25519") {
    throw new DkimParseError(`unsupported DKIM key algorithm: ${algorithm}`)
  }
  const keyBytes = base64Decode(p)
  return { algorithm, keyBytes }
}

function base64Decode(input: string): Uint8Array {
  // Strip whitespace; DKIM DNS records can split base64 across quoted strings.
  const cleaned = input.replace(/\s+/g, "")
  const binary = atob(cleaned)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/**
 * Split a raw RFC822 message into headers and body.
 * RFC 5322 mandates CRLF line endings, but real-world messages sometimes carry
 * only LF after intermediate storage (IMAP servers, mailbox files, scripts).
 * Accept either separator.
 *
 * Folded headers (a line ending followed by WSP) must NOT be treated as the
 * header/body boundary — the body separator is two consecutive line endings
 * with no WSP starting the second.
 */
export function splitMessage(raw: string): { headers: string[]; body: string } {
  // Find the first sequence of two line endings where neither line starts with
  // WSP. We try both CRLFCRLF and LFLF; whichever occurs first wins.
  let headerEnd = -1
  let sepLen = 0
  for (let i = 0; i < raw.length - 1; i++) {
    // Detect a line ending at position i.
    const at = (pos: number) => raw.charCodeAt(pos)
    let len1 = 0
    if (at(i) === 0x0d && at(i + 1) === 0x0a) len1 = 2
    else if (at(i) === 0x0a) len1 = 1
    if (!len1) continue

    // Determine what the NEXT line ending looks like, starting at i + len1.
    let len2 = 0
    const j = i + len1
    if (at(j) === 0x0d && at(j + 1) === 0x0a) len2 = 2
    else if (at(j) === 0x0a) len2 = 1

    if (!len2) {
      // Single line ending; advance past it.
      i += len1 - 1
      continue
    }

    // Two consecutive line endings. The first one is at position i, the second at j.
    // If the FIRST line ending is part of a folded continuation (i.e. the previous
    // char was WSP), it's not a real boundary. But the more common case is that
    // the SECOND line is the start of a folded continuation (e.g. "\r\n\theader")
    // — in which case the char at j+len2 is WSP, and this isn't a boundary.
    const charAtBoundary = at(j + len2)
    const isFolded = charAtBoundary === 0x20 || charAtBoundary === 0x09

    if (!isFolded) {
      headerEnd = i
      sepLen = len1 + len2
      break
    }
    // Skip past both newlines and the continuation character; we'll scan from
    // the next position on the next iteration.
    i = j + len2
  }

  if (headerEnd === -1) {
    return { headers: parseHeaders(raw), body: "" }
  }
  return {
    headers: parseHeaders(raw.slice(0, headerEnd)),
    body: raw.slice(headerEnd + sepLen),
  }
}

function parseHeaders(block: string): string[] {
  // RFC 5322 allows folded headers: a line ending followed by WSP continues
  // the previous header. Split on bare line endings (NOT followed by WSP) and
  // join folded continuations onto their parent header.
  const lines = block.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    if (line.length > 0 && (line[0] === " " || line[0] === "\t")) {
      if (out.length > 0) {
        // Folded continuation of previous header. Re-insert the line
        // ending so canonicalization can handle unfolding consistently.
        out[out.length - 1] += "\r\n" + line
        continue
      }
      // Stray leading WSP — keep as its own header (malformed input).
    }
    out.push(line)
  }
  return out
}

/**
 * Look up the value of a header from a list of raw header lines.
 * Returns the value portion only (the part after `Name: `), with folding
 * preserved so callers can canonicalize it themselves.
 */
function findHeader(headers: string[], name: string): string | undefined {
  const target = name.toLowerCase()
  for (const header of headers) {
    const colon = header.indexOf(":")
    if (colon === -1) continue
    if (header.slice(0, colon).toLowerCase() === target) {
      return header.slice(colon + 1)
    }
  }
  return undefined
}

/** Check that all required signed headers exist. Returns the headers that
 *  were found; throws DkimParseError listing the first missing one. */
function assertSignedHeadersPresent(
  headers: string[],
  required: string[],
): { name: string; value: string }[] {
  const found: { name: string; value: string }[] = []
  for (const name of required) {
    const value = findHeader(headers, name)
    if (value === undefined) {
      throw new DkimParseError(`signed header missing from message: ${name}`)
    }
    found.push({ name, value })
  }
  return found
}

/** Compute SHA-256 body hash of a canonicalized body. Returns base64. */
export async function sha256Base64(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return base64Encode(new Uint8Array(digest))
}

function base64Encode(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/** Verify a DKIM signature against the supplied public key. */
export async function verifyDkim(
  rawMessage: string,
  publicKey: DkimPublicKey,
  options: { now?: bigint } = {},
): Promise<DkimVerificationResult> {
  const { headers, body } = splitMessage(rawMessage)

  // Find the DKIM-Signature header — there may be more than one in theory
  // (multiple signatures for different domains), but we verify the first.
  let dkimRaw: string | undefined
  for (const line of headers) {
    if (line.toLowerCase().startsWith("dkim-signature:")) {
      dkimRaw = line.slice("dkim-signature:".length)
      break
    }
  }
  if (!dkimRaw) {
    return { valid: false, reason: "no DKIM-Signature header found" }
  }

  let parsed: DkimSignatureHeader
  try {
    parsed = parseDkimSignature(dkimRaw)
  } catch (err) {
    return {
      valid: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  if (parsed.expiration !== undefined) {
    const now = options.now ?? BigInt(Math.floor(Date.now() / 1000))
    if (parsed.expiration < now) {
      return { valid: false, parsed, reason: "signature expired" }
    }
  }

  const signedHeaders = assertSignedHeadersPresent(headers, parsed.signedHeaders)
  const canonicalBody = canonicalizeBody(body, parsed.canonicalization.body)
  const computedBodyHash = await sha256Base64(canonicalBody)

  if (!constantTimeEqualBase64(computedBodyHash, parsed.bodyHash)) {
    return {
      valid: false,
      parsed,
      reason: "body hash mismatch (body modified after signing)",
      computedBodyHash,
    }
  }

  // Build canonical input: each signed header in declared order, then DKIM-Signature
  // with b= set to empty (per RFC 6376 §3.7 step 5).
  const canonicalHeaderParts: string[] = []
  for (const { name, value } of signedHeaders) {
    canonicalHeaderParts.push(
      canonicalizeHeader(name, value, parsed.canonicalization.header),
    )
  }
  // DKIM-Signature itself is always signed; canonicalize it with empty b=.
  const strippedDkimHeader = stripTag(dkimRaw, "b")
  canonicalHeaderParts.push(
    canonicalizeHeader(
      "DKIM-Signature",
      strippedDkimHeader,
      parsed.canonicalization.header,
    ),
  )
  const canonicalInput = canonicalHeaderParts.join("") + computedBodyHash

  const verified = await verifySignature(parsed, canonicalInput, publicKey)

  return {
    valid: verified,
    parsed,
    computedBodyHash,
    computedInputPreview: canonicalInput.slice(0, 240),
    reason: verified ? undefined : "signature did not verify against public key",
  }
}

function stripTag(raw: string, tagName: string): string {
  // RFC 6376 §3.7 step 5: when computing the signature, the b= tag value is
  // removed (set to empty). The tag itself and its trailing separator stay,
  // so the header layout for signing is `...; b=; ...` not `...;  ...`.
  // The match consumes the value only; the `;` after is kept.
  const re = new RegExp(`(\\b${tagName}=)[^;]*`, "i")
  return raw.replace(re, "$1")
}

function constantTimeEqualBase64(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function verifySignature(
  parsed: DkimSignatureHeader,
  canonicalInput: string,
  publicKey: DkimPublicKey,
): Promise<boolean> {
  const signatureBytes = base64Decode(stripWhitespace(parsed.signature))
  // TextEncoder returns Uint8Array<ArrayBufferLike> which TypeScript treats
  // as not assignable to BufferSource on stricter lib.dom versions; coerce
  // to a fresh Uint8Array backed by ArrayBuffer.
  const data = new Uint8Array(new TextEncoder().encode(canonicalInput))

  if (parsed.algorithm === "rsa-sha256") {
    if (publicKey.algorithm !== "rsa") {
      throw new DkimParseError("algorithm/key mismatch (signature rsa-sha256 vs key ed25519)")
    }
    const spkiBytes = new Uint8Array(spkiForRsaPublicKey(publicKey.keyBytes))
    const cryptoKey = await crypto.subtle.importKey(
      "spki",
      spkiBytes,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    )
    return await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      cryptoKey,
      new Uint8Array(signatureBytes),
      data,
    )
  }

  if (parsed.algorithm === "ed25519-sha256") {
    if (publicKey.algorithm !== "ed25519") {
      throw new DkimParseError("algorithm/key mismatch (signature ed25519-sha256 vs key rsa)")
    }
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(publicKey.keyBytes),
      { name: "Ed25519" },
      false,
      ["verify"],
    )
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      cryptoKey,
      new Uint8Array(signatureBytes),
      data,
    )
  }

  throw new DkimParseError(`unsupported algorithm: ${parsed.algorithm}`)
}

function stripWhitespace(s: string): string {
  return s.replace(/\s+/g, "")
}

/**
 * Wrap an RSA SubjectPublicKeyInfo (SPKI) DER around a bare RSA public key
 * modulus+exponent blob. DKIM stores only the raw key bits (modulus +
 * exponent) in the DNS TXT record, so the verifier has to reconstruct the
 * ASN.1 envelope to import it into SubtleCrypto.
 *
 * SPKI for RSA = SEQUENCE { algorithm AlgorithmIdentifier, subjectPublicKey BIT STRING }
 * AlgorithmIdentifier = SEQUENCE { OID rsaEncryption, NULL }
 * OID 1.2.840.113549.1.1.1 encoded as 06 09 2A 86 48 86 F7 0D 01 01 01.
 */
function spkiForRsaPublicKey(rsaPublicKey: Uint8Array): Uint8Array {
  // rsaPublicKey is itself a SEQUENCE { modulus INTEGER, exponent INTEGER } per PKCS#1.
  // BIT STRING wraps it with one leading 0x00 (unused bits).
  const bitStringContent = new Uint8Array(rsaPublicKey.length + 1)
  bitStringContent[0] = 0x00
  bitStringContent.set(rsaPublicKey, 1)

  const algorithmIdentifier = new Uint8Array([
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  ])

  // BIT STRING tag (0x03) + length. The length encoding depends on size.
  const bitString = encodeDerLengthPrefixed(0x03, bitStringContent)
  const inner = concat(algorithmIdentifier, bitString)
  return encodeDerLengthPrefixed(0x30, inner)
}

function encodeDerLengthPrefixed(tag: number, content: Uint8Array): Uint8Array {
  const lengthBytes = encodeDerLength(content.length)
  const out = new Uint8Array(1 + lengthBytes.length + content.length)
  out[0] = tag
  out.set(lengthBytes, 1)
  out.set(content, 1 + lengthBytes.length)
  return out
}

function encodeDerLength(length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([length])
  // Long form: 0x80 | numBytes, then big-endian length bytes.
  const bytes: number[] = []
  let n = length
  while (n > 0) {
    bytes.unshift(n & 0xff)
    n >>= 8
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes])
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}
