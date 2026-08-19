export const STALWART_ACCOUNT = "d333333"

export interface JmapCall {
  using: string[]
  methodCalls: [string, Record<string, unknown>, string][]
}

export interface JmapResponse {
  methodResponses: [string, Record<string, unknown>, string][]
  sessionState: string
}

interface DomainDkimState {
  id: string
  name: string
  dkimManagement?: { "@type"?: string }
}

interface DkimSignature {
  "@type": "Dkim1Ed25519Sha256" | "Dkim1RsaSha256"
  domainId: string
  publicKey: string
  selector: string
  stage: string
}

export class DkimInvariantError extends Error {
  override name = "DkimInvariantError"
}

function validateDomain(domain: string): string {
  const normalized = domain.toLowerCase()
  if (
    normalized.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(normalized)
  ) {
    throw new Error(`Invalid mail domain: ${domain}`)
  }
  return normalized
}

export async function callStalwartJmap(
  domain: string,
  password: string,
  calls: JmapCall,
): Promise<JmapResponse> {
  const hostname = `mail.${validateDomain(domain)}`
  const url = new URL(`https://${hostname}/jmap/`)
  if (url.hostname !== hostname) throw new Error("Invalid Stalwart JMAP hostname")
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`admin:${password}`)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(calls),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`JMAP request failed: HTTP ${response.status}`)

  const result = await response.json() as JmapResponse
  const methodError = result.methodResponses.find(([method]) => method === "error")
  if (methodError) throw new Error(`JMAP method failed: ${JSON.stringify(methodError[1])}`)
  return result
}

export function getMethodResponse(
  response: JmapResponse,
  methodName: string,
): Record<string, unknown> {
  const method = response.methodResponses.find(([name]) => name === methodName)
  if (!method) throw new Error(`JMAP response missing ${methodName}`)
  return method[1]
}

async function getDomains(domain: string, password: string): Promise<DomainDkimState[]> {
  const response = await callStalwartJmap(domain, password, {
    using: ["urn:ietf:params:jmap:core"],
    methodCalls: [
      ["x:Domain/query", { accountId: STALWART_ACCOUNT, limit: 50 }, "0"],
      ["x:Domain/get", {
        accountId: STALWART_ACCOUNT,
        "#ids": { resultOf: "0", name: "x:Domain/query", path: "/ids" },
        properties: ["id", "name", "dkimManagement"],
      }, "1"],
    ],
  })
  const domains = getMethodResponse(response, "x:Domain/get").list as
    | DomainDkimState[]
    | undefined
  if (!domains?.length) throw new DkimInvariantError("Stalwart returned no mail domains")
  return domains
}

function assertExpectedDomains(domains: DomainDkimState[], expectedDomains: string[]): void {
  const found = new Set(domains.map((domain) => domain.name))
  const missing = expectedDomains.filter((domain) => !found.has(domain))
  if (missing.length) {
    throw new DkimInvariantError(`Stalwart missing expected domains: ${missing.join(", ")}`)
  }
}

export async function ensureManualDkimManagement(
  domain: string,
  password: string,
  expectedDomains: string[],
): Promise<number> {
  const domains = await getDomains(domain, password)
  assertExpectedDomains(domains, expectedDomains)
  const expected = new Set(expectedDomains)
  const automatic = domains.filter((item) =>
    expected.has(item.name) && item.dkimManagement?.["@type"] !== "Manual"
  )

  if (automatic.length) {
    const update = Object.fromEntries(
      automatic.map((item) => [item.id, { dkimManagement: { "@type": "Manual" } }]),
    )
    const response = await callStalwartJmap(domain, password, {
      using: ["urn:ietf:params:jmap:core"],
      methodCalls: [[
        "x:Domain/set",
        { accountId: STALWART_ACCOUNT, update },
        "0",
      ]],
    })
    const notUpdated = getMethodResponse(response, "x:Domain/set").notUpdated as
      | Record<string, unknown>
      | undefined
    if (notUpdated && Object.keys(notUpdated).length) {
      throw new DkimInvariantError(
        `failed to update DKIM domains: ${JSON.stringify(notUpdated)}`,
      )
    }
  }

  const verified = await getDomains(domain, password)
  assertExpectedDomains(verified, expectedDomains)
  const nonManual = verified.filter((item) =>
    expected.has(item.name) && item.dkimManagement?.["@type"] !== "Manual"
  )
  if (nonManual.length) {
    throw new DkimInvariantError(
      `DKIM management remains automatic: ${nonManual.map((d) => d.name).join(", ")}`,
    )
  }
  return automatic.length
}

export function normalizeTxtRecord(value: string): string {
  return value.replace(/^"|"$/g, "").replace(/"\s+"/g, "").replace(/\s/g, "")
}

async function resolveTxt(name: string): Promise<string[]> {
  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
    {
      headers: { Accept: "application/dns-json" },
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!response.ok) throw new Error(`DNS query failed for ${name}: HTTP ${response.status}`)
  const result = await response.json() as { Answer?: Array<{ data: string }> }
  return (result.Answer ?? []).map((answer) => normalizeTxtRecord(answer.data))
}

export async function verifyActiveDkimDns(
  domain: string,
  password: string,
  expectedDomains: string[],
): Promise<number> {
  const domains = await getDomains(domain, password)
  assertExpectedDomains(domains, expectedDomains)
  const domainById = new Map(domains.map((item) => [item.id, item.name]))

  const response = await callStalwartJmap(domain, password, {
    using: ["urn:ietf:params:jmap:core"],
    methodCalls: [
      ["x:DkimSignature/query", { accountId: STALWART_ACCOUNT, limit: 50 }, "0"],
      ["x:DkimSignature/get", {
        accountId: STALWART_ACCOUNT,
        "#ids": { resultOf: "0", name: "x:DkimSignature/query", path: "/ids" },
      }, "1"],
    ],
  })
  const signatures = (getMethodResponse(response, "x:DkimSignature/get").list as
    | DkimSignature[]
    | undefined)?.filter((signature) => signature.stage === "active") ?? []
  if (!signatures.length) {
    throw new DkimInvariantError("Stalwart returned no active DKIM signatures")
  }

  const algorithmsByDomain = new Map<string, Set<string>>()
  for (const signature of signatures) {
    const signatureDomain = domainById.get(signature.domainId)
    if (!signatureDomain || !expectedDomains.includes(signatureDomain)) continue
    const algorithm = signature["@type"] === "Dkim1Ed25519Sha256" ? "ed25519" : "rsa"
    const name = `${signature.selector}._domainkey.${signatureDomain}`
    const expected = normalizeTxtRecord(
      `v=DKIM1; k=${algorithm}; h=sha256; p=${signature.publicKey}`,
    )
    const records = await resolveTxt(name)
    if (!records.includes(expected)) {
      throw new DkimInvariantError(`public DKIM record mismatch: ${name}`)
    }

    const algorithms = algorithmsByDomain.get(signatureDomain) ?? new Set<string>()
    algorithms.add(algorithm)
    algorithmsByDomain.set(signatureDomain, algorithms)
  }

  for (const expectedDomain of expectedDomains) {
    const algorithms = algorithmsByDomain.get(expectedDomain)
    if (!algorithms?.has("ed25519") || !algorithms.has("rsa")) {
      throw new DkimInvariantError(`missing active dual DKIM signatures for ${expectedDomain}`)
    }
  }
  return signatures.length
}
