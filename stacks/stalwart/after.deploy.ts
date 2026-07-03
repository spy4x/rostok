// after.deploy.ts — Configure Stalwart anti-lockout IaC.
// Adds Docker proxy subnet (172.18.0.0/16) to Allowed IPs so fail2ban never
// blocks reverse proxy. Removes any blocked IPs from same subnet.
// Uses JMAP management API via admin credentials from .env.

const SSH = Deno.env.get("SSH_ADDRESS") ?? ""
const PASSWORD = Deno.env.get("STALWART_ADMIN_PASSWORD") ?? ""

if (!SSH || !PASSWORD) {
  console.error("after.deploy.ts: SSH_ADDRESS and STALWART_ADMIN_PASSWORD must be set")
  Deno.exit(1)
}

const STALWART = "172.18.0.8:8080" // Docker bridge IP — always reachable from host
const SUBNET = "172.18.0.0/16"
const ACCOUNT = "d333333" // system principal account ID

interface JmapCall {
  using: string[]
  methodCalls: [string, Record<string, unknown>, string][]
}

interface JmapResponse {
  methodResponses: [string, Record<string, unknown>, string][]
  sessionState: string
}

/** Call Stalwart JMAP API from the cloud server via SSH */
async function jmap(calls: JmapCall): Promise<JmapResponse> {
  const body = JSON.stringify(calls)
  const proc = new Deno.Command("ssh", {
    args: [
      SSH,
      "curl",
      "-s",
      "-u",
      `admin:${PASSWORD}`,
      "-X",
      "POST",
      `http://${STALWART}/jmap/`,
      "-H",
      "Content-Type: application/json",
      "-d",
      body,
    ],
    stdout: "piped",
    stderr: "piped",
  })
  const out = await proc.output()
  if (out.code !== 0) {
    const err = new TextDecoder().decode(out.stderr).trim()
    throw new Error(`jmap call failed (exit ${out.code}): ${err}`)
  }
  try {
    return JSON.parse(new TextDecoder().decode(out.stdout))
  } catch {
    throw new Error(
      `jmap call returned invalid JSON: ${new TextDecoder().decode(out.stdout).slice(0, 200)}`,
    )
  }
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

/** Poll until Stalwart responds to health check (up to 60s) */
async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const proc = new Deno.Command("ssh", {
      args: [SSH, "curl", "-sf", `http://${STALWART}/healthz/live`],
      stdout: "null",
      stderr: "null",
    })
    const out = await proc.output()
    if (out.code === 0) return
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error("Stalwart did not become healthy within 60s")
}

async function main() {
  console.log("Waiting for Stalwart to become healthy...")
  await waitHealthy()
  console.log("✓ Stalwart healthy")

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
}

try {
  await main()
} catch (err) {
  console.error("after.deploy.ts FAILED:", err instanceof Error ? err.message : String(err))
  // Non-fatal — Stalwart may work with manual config. Don't block deploy.
  Deno.exit(0)
}
