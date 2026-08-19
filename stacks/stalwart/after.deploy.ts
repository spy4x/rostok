// after.deploy.ts — Configure Stalwart anti-lockout + outbound HELO IaC.
// 1. Adds Docker proxy subnet (172.18.0.0/16) to Allowed IPs so fail2ban never
//    blocks reverse proxy. Removes any blocked IPs from same subnet.
// 2. Sets SystemSettings.defaultHostname to mail.${DOMAIN} so outbound EHLO is
//    a valid FQDN (RFC 2821 4.1.1.1). Without this, Stalwart falls back to the
//    container hostname (e.g. "55458b1fafce") and remote MTAs reject with
//    "Access denied - Invalid HELO name".
// 3. Keeps DKIM management manual while Cloudflare DNS publication is manual.
//    Automatic key rotation without automatic DNS publication breaks DKIM.
// Uses JMAP management API via admin credentials from .env.

import {
  callStalwartJmap,
  DkimInvariantError,
  ensureManualDkimManagement,
  STALWART_ACCOUNT,
  verifyActiveDkimDns,
} from "./dkim.ts"
import type { JmapCall, JmapResponse } from "./dkim.ts"

const PASSWORD = Deno.env.get("STALWART_ADMIN_PASSWORD") ?? ""
const DOMAIN = Deno.env.get("DOMAIN") ?? ""
const NEATSOFT_DOMAIN = Deno.env.get("NEATSOFT_DOMAIN") ?? ""
const SSH = Deno.env.get("SSH_ADDRESS") ?? ""
const INITIAL_DEPLOY = Deno.env.get("STALWART_INITIAL_DEPLOY") === "true"

if (!PASSWORD || !DOMAIN || !NEATSOFT_DOMAIN || !SSH) {
  console.error(
    "after.deploy.ts: STALWART_ADMIN_PASSWORD, DOMAIN, NEATSOFT_DOMAIN and SSH_ADDRESS must be set",
  )
  Deno.exit(1)
}

const SUBNET = "172.18.0.0/16"
const ACCOUNT = STALWART_ACCOUNT
const DEFAULT_HOSTNAME = `mail.${DOMAIN}`
const EXPECTED_DKIM_DOMAINS = [DOMAIN, NEATSOFT_DOMAIN]
let stalwartStopped = false

/** Call Stalwart's public HTTPS JMAP endpoint without exposing credentials in argv. */
function jmap(calls: JmapCall): Promise<JmapResponse> {
  return callStalwartJmap(DOMAIN, PASSWORD, calls)
}

/** Find blocked IPs in our subnet and destroy them */
async function clearBlockedIps(): Promise<number> {
  // Query blocked IPs
  const query = await jmap({
    using: ["urn:ietf:params:jmap:core"],
    methodCalls: [
      ["x:BlockedIp/query", { accountId: ACCOUNT, limit: 100, position: 0 }, "0"],
      ["x:BlockedIp/get", {
        accountId: ACCOUNT,
        "#ids": { resultOf: "0", name: "x:BlockedIp/query", path: "/ids" },
        properties: ["id", "address"],
      }, "1"],
    ],
  })

  const getResp = query.methodResponses.find(([m]) => m === "x:BlockedIp/get")
  const list = (getResp?.[1] as Record<string, unknown>)?.list as
    | Array<{ id: string; address: string }>
    | undefined
  const toDestroy = (list ?? []).filter((e) => e.address.startsWith("172.18"))

  if (!toDestroy.length) return 0

  // Destroy matching blocked IPs
  const destroyIds = Object.fromEntries(toDestroy.map((e) => [e.id, true]))
  await jmap({
    using: ["urn:ietf:params:jmap:core"],
    methodCalls: [
      ["x:BlockedIp/set", { accountId: ACCOUNT, destroy: destroyIds }, "0"],
    ],
  })

  return toDestroy.length
}

/** Ensure Docker subnet is in Allowed IPs */
async function ensureAllowedIp(): Promise<boolean> {
  const query = await jmap({
    using: ["urn:ietf:params:jmap:core"],
    methodCalls: [
      ["x:AllowedIp/query", { accountId: ACCOUNT, limit: 100, position: 0 }, "0"],
      ["x:AllowedIp/get", {
        accountId: ACCOUNT,
        "#ids": { resultOf: "0", name: "x:AllowedIp/query", path: "/ids" },
        properties: ["id", "address"],
      }, "1"],
    ],
  })

  const getResp = query.methodResponses.find(([m]) => m === "x:AllowedIp/get")
  const list = (getResp?.[1] as Record<string, unknown>)?.list as
    | Array<{ id: string; address: string }>
    | undefined

  if ((list ?? []).some((e) => e.address === SUBNET)) {
    return false // already exists
  }

  await jmap({
    using: ["urn:ietf:params:jmap:core"],
    methodCalls: [
      ["x:AllowedIp/set", {
        accountId: ACCOUNT,
        create: { "docker-proxy": { address: SUBNET, reason: "Docker proxy network" } },
      }, "0"],
    ],
  })

  return true
}

/** Ensure SMTP submission port 587 listener exists */
async function ensureSmtp587(): Promise<boolean> {
  const query = await jmap({
    using: ["urn:ietf:params:jmap:core"],
    methodCalls: [
      ["x:NetworkListener/query", { accountId: ACCOUNT, limit: 50, position: 0 }, "0"],
      ["x:NetworkListener/get", {
        accountId: ACCOUNT,
        "#ids": { resultOf: "0", name: "x:NetworkListener/query", path: "/ids" },
        properties: ["id", "protocol", "bind"],
      }, "1"],
    ],
  })

  const getResp = query.methodResponses.find(([m]) => m === "x:NetworkListener/get")
  const list = (getResp?.[1] as Record<string, unknown>)?.list as
    | Array<{ id: string; protocol: string; bind: Record<string, boolean> }>
    | undefined

  if (
    (list ?? []).some((e) =>
      e.protocol === "smtp" && Object.keys(e.bind).some((b) => b.endsWith(":587"))
    )
  ) {
    return false // port 587 listener already exists
  }

  await jmap({
    using: ["urn:ietf:params:jmap:core"],
    methodCalls: [
      ["x:NetworkListener/set", {
        accountId: ACCOUNT,
        create: {
          "submission": {
            protocol: "smtp",
            name: "submission",
            bind: { "0.0.0.0:587": true, "[::]:587": true },
            useTls: true,
            tlsImplicit: false,
            maxConnections: 8192,
            socketBacklog: 1024,
          },
        },
      }, "0"],
    ],
  })

  return true
}

/** Ensure SystemSettings.defaultHostname is set to a valid FQDN.
 *  Required so outbound SMTP EHLO advertises a real hostname instead of the
 *  docker container ID (which remote MTAs reject per RFC 2821 4.1.1.1). */
async function ensureDefaultHostname(): Promise<"created" | "updated" | "unchanged"> {
  // Look up primary domain id (the one matching DOMAIN).
  const query = await jmap({
    using: ["urn:ietf:params:jmap:core"],
    methodCalls: [
      ["x:Domain/query", { accountId: ACCOUNT, limit: 50 }, "0"],
      ["x:Domain/get", {
        accountId: ACCOUNT,
        "#ids": { resultOf: "0", name: "x:Domain/query", path: "/ids" },
        properties: ["id", "name"],
      }, "1"],
    ],
  })
  const list = (query.methodResponses.find(([m]) => m === "x:Domain/get")?.[1] as {
    list?: Array<{ id: string; name: string }>
  })?.list ?? []
  const primary = list.find((d) => d.name === DOMAIN) ?? list[0]
  if (!primary) throw new Error("no domain configured in Stalwart")

  // Read current settings (singleton may not exist yet).
  const get = await jmap({
    using: ["urn:ietf:params:jmap:core"],
    methodCalls: [
      ["x:SystemSettings/get", {
        accountId: ACCOUNT,
        ids: ["singleton"],
      }, "0"],
    ],
  })
  const settings = (get.methodResponses[0][1] as { list?: Array<Record<string, unknown>> }).list
    ?.[0]

  if (!settings) {
    // Create singleton with the minimum required fields.
    await jmap({
      using: ["urn:ietf:params:jmap:core"],
      methodCalls: [
        ["x:SystemSettings/set", {
          accountId: ACCOUNT,
          create: {
            singleton: {
              defaultHostname: DEFAULT_HOSTNAME,
              defaultDomainId: primary.id,
              maxConnections: 8192,
              threadPoolSize: 8,
            },
          },
        }, "0"],
      ],
    })
    return "created"
  }

  if (settings.defaultHostname === DEFAULT_HOSTNAME) return "unchanged"

  await jmap({
    using: ["urn:ietf:params:jmap:core"],
    methodCalls: [
      ["x:SystemSettings/set", {
        accountId: ACCOUNT,
        update: { singleton: { defaultHostname: DEFAULT_HOSTNAME } },
      }, "0"],
    ],
  })
  return "updated"
}

/** Poll until Stalwart responds to health check (up to 60s) */
async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const response = await fetch(`https://mail.${DOMAIN}/healthz/live`, {
        signal: AbortSignal.timeout(5_000),
      })
      if (response.ok) return
    } catch {
      // Retry until deployment timeout.
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error("Stalwart did not become healthy within 60s")
}

async function stopStalwartAfterDkimFailure(): Promise<void> {
  if (!/^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*@)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(SSH)) {
    throw new Error("Invalid SSH_ADDRESS")
  }
  const result = await new Deno.Command("ssh", {
    args: [SSH, "docker", "stop", "hl-stalwart"],
    stdout: "null",
    stderr: "piped",
  }).output()
  if (result.code !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim())
  }
  stalwartStopped = true
}

async function main() {
  console.log("Waiting for Stalwart to become healthy...")
  await waitHealthy()
  console.log("✓ Stalwart healthy")

  try {
    const manualDkim = await ensureManualDkimManagement(
      DOMAIN,
      PASSWORD,
      EXPECTED_DKIM_DOMAINS,
    )
    if (manualDkim > 0) console.log(`✓ Set manual DKIM management for ${manualDkim} domain(s)`)
    else console.log("✓ DKIM management already manual")
    const verifiedDkim = await verifyActiveDkimDns(DOMAIN, PASSWORD, EXPECTED_DKIM_DOMAINS)
    console.log(`✓ Verified ${verifiedDkim} active DKIM key(s) in public DNS`)
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    if (err instanceof DkimInvariantError || INITIAL_DEPLOY) {
      try {
        await stopStalwartAfterDkimFailure()
      } catch (stopError) {
        throw new Error(
          `${errorMessage}; failed to stop Stalwart: ${
            stopError instanceof Error ? stopError.message : String(stopError)
          }`,
        )
      }
      throw new Error(`${errorMessage}; stopped Stalwart to prevent invalid DKIM delivery`)
    }
    throw err
  }

  try {
    const cleared = await clearBlockedIps()
    if (cleared > 0) console.log(`✓ Cleared ${cleared} blocked IP(s) from Docker subnet`)

    const added = await ensureAllowedIp()
    if (added) {
      console.log(`✓ Added ${SUBNET} to Allowed IPs (anti-lockout)`)
    } else {
      console.log(`✓ ${SUBNET} already in Allowed IPs`)
    }

    const smtp587 = await ensureSmtp587()
    if (smtp587) {
      console.log("✓ Added SMTP port 587 listener (submission)")
    } else {
      console.log("✓ SMTP port 587 listener already exists")
    }

    const hostname = await ensureDefaultHostname()
    if (hostname === "created") console.log(`✓ Set defaultHostname to ${DEFAULT_HOSTNAME}`)
    else if (hostname === "updated") console.log(`✓ Updated defaultHostname to ${DEFAULT_HOSTNAME}`)
    else console.log(`✓ defaultHostname already ${DEFAULT_HOSTNAME}`)
  } catch (err) {
    console.warn("Non-critical Stalwart setup failed:", err instanceof Error ? err.message : err)
  }
}

try {
  await main()
} catch (err) {
  let errorMessage = err instanceof Error ? err.message : String(err)
  if (INITIAL_DEPLOY && !stalwartStopped) {
    try {
      await stopStalwartAfterDkimFailure()
      errorMessage += "; stopped initial Stalwart deployment before DKIM verification"
    } catch (stopError) {
      errorMessage += `; failed to stop initial Stalwart deployment: ${
        stopError instanceof Error ? stopError.message : String(stopError)
      }`
    }
  }
  console.error("after.deploy.ts FAILED:", errorMessage)
  Deno.exit(1)
}
