import { assertEquals, assertRejects } from "@std/assert"
import {
  callStalwartJmap,
  DkimInvariantError,
  ensureManualDkimManagement,
  normalizeTxtRecord,
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
