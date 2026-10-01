import { assertEquals, assertRejects } from "@std/assert"
import {
  callStalwartJmap,
  DkimInvariantError,
  ensureDkimSignedHeaders,
  ensureManualDkimManagement,
  normalizeTxtRecord,
  REQUIRED_SIGNED_HEADERS,
  verifyActiveDkimDns,
} from "./dkim.ts"

function jmapResponse(methodResponses: unknown[]): Response {
  return Response.json({ methodResponses, sessionState: "test" })
}

function domainGetResponse(dkimType: "Automatic" | "Manual", includeOther = false): Response {
  const domains = [
    { id: "domain-1", name: "example.com", dkimManagement: { "@type": dkimType } },
  ]
  if (includeOther) {
    domains.push({
      id: "domain-2",
      name: "other.example",
      dkimManagement: { "@type": "Automatic" },
    })
  }
  return jmapResponse([
    ["x:Domain/query", { ids: domains.map((domain) => domain.id) }, "0"],
    ["x:Domain/get", { list: domains }, "1"],
  ])
}

Deno.test("normalizeTxtRecord joins split RSA TXT chunks", () => {
  assertEquals(
    normalizeTxtRecord('"v=DKIM1; k=rsa; p=first" "second"'),
    "v=DKIM1;k=rsa;p=firstsecond",
  )
})

Deno.test("callStalwartJmap rejects credential-forwarding domain", async () => {
  await assertRejects(
    () =>
      callStalwartJmap("example.com@attacker.test", "password", {
        using: ["urn:ietf:params:jmap:core"],
        methodCalls: [],
      }),
    Error,
    "Invalid mail domain",
  )
})

Deno.test("ensureManualDkimManagement updates only expected domains", async () => {
  const originalFetch = globalThis.fetch
  let domainReads = 0
  let update: Record<string, unknown> | undefined
  globalThis.fetch = (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      methodCalls: [string, Record<string, unknown>, string][]
    }
    if (body.methodCalls.some(([method]) => method === "x:Domain/set")) {
      update = body.methodCalls[0][1].update as Record<string, unknown>
      return Promise.resolve(
        jmapResponse([["x:Domain/set", { updated: { "domain-1": null } }, "0"]]),
      )
    }
    domainReads++
    return Promise.resolve(domainGetResponse(domainReads === 1 ? "Automatic" : "Manual", true))
  }

  try {
    assertEquals(
      await ensureManualDkimManagement("example.com", "password", ["example.com"]),
      1,
    )
    assertEquals(Object.keys(update ?? {}), ["domain-1"])
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("ensureManualDkimManagement rejects notUpdated domains", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      methodCalls: [string, Record<string, unknown>, string][]
    }
    if (body.methodCalls.some(([method]) => method === "x:Domain/set")) {
      return Promise.resolve(jmapResponse([["x:Domain/set", {
        notUpdated: { "domain-1": { type: "serverFail" } },
      }, "0"]]))
    }
    return Promise.resolve(domainGetResponse("Automatic"))
  }

  try {
    await assertRejects(
      () => ensureManualDkimManagement("example.com", "password", ["example.com"]),
      DkimInvariantError,
      "failed to update DKIM domains",
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("verifyActiveDkimDns rejects missing active algorithm", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    if (String(input).startsWith("https://cloudflare-dns.com/")) {
      return Promise.resolve(Response.json({
        Answer: [{ data: '"v=DKIM1; k=rsa; h=sha256; p=public"' }],
      }))
    }
    const body = JSON.parse(String(init?.body)) as {
      methodCalls: [string, Record<string, unknown>, string][]
    }
    if (body.methodCalls.some(([method]) => method === "x:DkimSignature/query")) {
      return Promise.resolve(jmapResponse([
        ["x:DkimSignature/query", { ids: ["key-1"] }, "0"],
        ["x:DkimSignature/get", {
          list: [{
            "@type": "Dkim1RsaSha256",
            domainId: "domain-1",
            publicKey: "public",
            selector: "rsa-test",
            stage: "active",
          }],
        }, "1"],
      ]))
    }
    return Promise.resolve(domainGetResponse("Manual"))
  }

  try {
    await assertRejects(
      () => verifyActiveDkimDns("example.com", "password", ["example.com"]),
      DkimInvariantError,
      "missing active dual DKIM signatures",
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("verifyActiveDkimDns rejects public key mismatch", async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    if (String(input).startsWith("https://cloudflare-dns.com/")) {
      return Promise.resolve(Response.json({ Answer: [{ data: '"v=DKIM1; k=rsa; p=wrong"' }] }))
    }
    const body = JSON.parse(String(init?.body)) as {
      methodCalls: [string, Record<string, unknown>, string][]
    }
    if (body.methodCalls.some(([method]) => method === "x:DkimSignature/query")) {
      return Promise.resolve(jmapResponse([
        ["x:DkimSignature/query", { ids: ["key-1"] }, "0"],
        ["x:DkimSignature/get", {
          list: [{
            "@type": "Dkim1RsaSha256",
            domainId: "domain-1",
            publicKey: "public",
            selector: "rsa-test",
            stage: "active",
          }],
        }, "1"],
      ]))
    }
    return Promise.resolve(domainGetResponse("Manual"))
  }

  try {
    await assertRejects(
      () => verifyActiveDkimDns("example.com", "password", ["example.com"]),
      DkimInvariantError,
      "public DKIM record mismatch",
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

/** A fake Stalwart holding `signatures`; records the update it is sent. */
function fakeSignatures(
  signatures: Array<{ id: string; headers: Record<string, boolean> }>,
  setResult: Record<string, unknown> = { updated: {} },
) {
  const state: { update?: Record<string, { headers: Record<string, boolean> }> } = {}
  const fetch = (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      methodCalls: [string, Record<string, unknown>, string][]
    }
    const [method, args] = body.methodCalls[0]
    if (method === "x:DkimSignature/set") {
      state.update = args.update as typeof state.update
      return Promise.resolve(jmapResponse([["x:DkimSignature/set", setResult, "0"]]))
    }
    return Promise.resolve(jmapResponse([
      ["x:DkimSignature/query", { ids: signatures.map((s) => s.id) }, "0"],
      ["x:DkimSignature/get", { list: signatures }, "1"],
    ]))
  }
  return { fetch, state }
}

const DEFAULT_SIGNED = { From: true, To: true, Date: true, Subject: true, "Message-ID": true }

Deno.test("ensureDkimSignedHeaders signs the unsubscribe headers and keeps existing ones", async () => {
  const originalFetch = globalThis.fetch
  const fake = fakeSignatures([
    { id: "s1", headers: { ...DEFAULT_SIGNED, "X-Custom": true } },
    { id: "s2", headers: DEFAULT_SIGNED },
  ])
  globalThis.fetch = fake.fetch as typeof fetch
  try {
    assertEquals(await ensureDkimSignedHeaders("example.com", "password"), 2)
    const s1 = fake.state.update?.s1.headers ?? {}
    assertEquals(s1["List-Unsubscribe"], true)
    assertEquals(s1["List-Unsubscribe-Post"], true)
    assertEquals(s1["X-Custom"], true)
    for (const name of REQUIRED_SIGNED_HEADERS) assertEquals(s1[name], true, name)
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("ensureDkimSignedHeaders changes nothing when every signature is complete", async () => {
  const originalFetch = globalThis.fetch
  const complete = Object.fromEntries(REQUIRED_SIGNED_HEADERS.map((name) => [name, true]))
  const fake = fakeSignatures([{ id: "s1", headers: complete }])
  globalThis.fetch = fake.fetch as typeof fetch
  try {
    assertEquals(await ensureDkimSignedHeaders("example.com", "password"), 0)
    assertEquals(fake.state.update, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("ensureDkimSignedHeaders fails when the server refuses the update", async () => {
  const originalFetch = globalThis.fetch
  const fake = fakeSignatures([{ id: "s1", headers: DEFAULT_SIGNED }], {
    notUpdated: { s1: { type: "invalidProperties" } },
  })
  globalThis.fetch = fake.fetch as typeof fetch
  try {
    await assertRejects(() => ensureDkimSignedHeaders("example.com", "password"), Error, "signed")
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test("ensureDkimSignedHeaders fails when it finds no signatures", async () => {
  const originalFetch = globalThis.fetch
  const fake = fakeSignatures([])
  globalThis.fetch = fake.fetch as typeof fetch
  try {
    await assertRejects(() => ensureDkimSignedHeaders("example.com", "password"), Error, "no DKIM")
  } finally {
    globalThis.fetch = originalFetch
  }
})
