// Ensure a Stalwart mail account exists, and optionally redirect its mail.
//
// The use case is a sending identity for an app: a site that mails as
// `hello@example.com` needs an account of its own to log in to SMTP with, so
// it never holds the owner's personal password. Mail that people send back to
// that address should land in the owner's inbox, not in a mailbox nobody
// opens, so `--redirect` installs a one-line Sieve script on the new account
// that forwards everything to the owner's address (without keeping a copy).
//
// Idempotent: an existing account is left as it is (its password is not
// changed), and the redirect script is replaced on every run.
//
// Usage:
//   STALWART_ADMIN_PASSWORD=… ACCOUNT_PASSWORD=… deno run -A \
//     scripts/stalwart/ensure-account.ts \
//     --server mail.example.com \
//     --address hello@example.com \
//     --description "Jane Doe" \
//     --password-env ACCOUNT_PASSWORD \
//     --redirect jane@example.com

import { apply as applySieve } from "./apply-sieve-filters.ts"

/** Stalwart's management account id for the admin principal. */
export const ADMIN_ACCOUNT_ID = "d333333"

export interface EnsureAccountOptions {
  /** Host of the Stalwart JMAP endpoint, e.g. `mail.example.com`. */
  server: string
  /** The account's address; its local part becomes the account name. */
  address: string
  /** Shown as the account's display name in Stalwart. */
  description: string
  /** Name of the env variable that holds the new account's password. */
  passwordEnv: string
  /** Where every incoming mail is redirected; no redirect when absent. */
  redirect?: string
}

export interface JmapCall {
  using: string[]
  methodCalls: Array<[string, Record<string, unknown>, string]>
}
export interface JmapResponse {
  methodResponses: Array<[string, Record<string, unknown>, string]>
}
export type Jmap = (call: JmapCall) => Promise<JmapResponse>

const ADDRESS = /^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/
const HOST = /^[a-z0-9.-]+\.[a-z]{2,}$/

/** Parses `--key value` pairs. Throws on a missing or malformed value. */
export function parseArgs(args: string[]): EnsureAccountOptions {
  const opts: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (!key.startsWith("--")) throw new Error(`unexpected argument "${key}"`)
    const value = args[i + 1]
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${key} needs a value`)
    }
    opts[key.slice(2)] = value
    i++
  }
  const { server, address, description } = opts
  const passwordEnv = opts["password-env"]
  if (!server || !HOST.test(server)) throw new Error("--server must be a host name")
  if (!address || !ADDRESS.test(address)) throw new Error("--address must be an address")
  if (!description) throw new Error("--description is required")
  if (!passwordEnv) throw new Error("--password-env is required")
  const redirect = opts.redirect
  if (redirect !== undefined && !ADDRESS.test(redirect)) {
    throw new Error("--redirect must be an address")
  }
  if (redirect === address) throw new Error("--redirect must differ from --address")
  return { server, address, description, passwordEnv, ...(redirect ? { redirect } : {}) }
}

/** The Sieve script that forwards every message to `target` and keeps none. */
export function redirectSieve(target: string): string {
  if (!ADDRESS.test(target)) throw new Error("redirect target must be an address")
  return `# Managed by rostok scripts/stalwart/ensure-account.ts\nredirect "${target}";\n`
}

function list(response: JmapResponse, method: string): Array<Record<string, unknown>> {
  const found = response.methodResponses.find(([name]) => name === method)
  if (!found) throw new Error(`JMAP response missing ${method}`)
  return (found[1].list as Array<Record<string, unknown>> | undefined) ?? []
}

/**
 * Creates the account when no account has `address` yet.
 * Returns its id and whether it was created.
 */
export async function ensureAccount(
  jmap: Jmap,
  opts: Pick<EnsureAccountOptions, "address" | "description">,
  password: string,
): Promise<{ id: string; created: boolean }> {
  if (password.length < 24) throw new Error("the account password must be 24+ characters")
  const [name, domain] = opts.address.split("@")
  const lookup = await jmap({
    using: ["urn:ietf:params:jmap:core"],
    methodCalls: [
      ["x:Domain/get", { accountId: ADMIN_ACCOUNT_ID, ids: null, properties: ["id", "name"] }, "0"],
      [
        "x:Account/get",
        { accountId: ADMIN_ACCOUNT_ID, ids: null, properties: ["id", "emailAddress"] },
        "1",
      ],
    ],
  })
  const existing = list(lookup, "x:Account/get").find((a) => a.emailAddress === opts.address)
  if (existing) return { id: String(existing.id), created: false }
  const domainRow = list(lookup, "x:Domain/get").find((d) => d.name === domain)
  if (!domainRow) throw new Error(`domain ${domain} is not configured in Stalwart`)

  const created = await jmap({
    using: ["urn:ietf:params:jmap:core"],
    methodCalls: [[
      "x:Account/set",
      {
        accountId: ADMIN_ACCOUNT_ID,
        create: {
          new: {
            "@type": "User",
            name,
            domainId: domainRow.id,
            description: opts.description,
            roles: { "@type": "User" },
            credentials: { "0": { "@type": "Password", secret: password } },
          },
        },
      },
      "0",
    ]],
  })
  const result = created.methodResponses[0][1]
  const id = (result.created as Record<string, { id: string }> | undefined)?.new?.id
  if (!id) throw new Error(`account not created: ${JSON.stringify(result.notCreated ?? result)}`)
  return { id, created: true }
}

/** Basic-auth JMAP client for `server`, never putting the password in argv. */
export function jmapClient(server: string, user: string, password: string): Jmap {
  return async (call) => {
    const response = await fetch(`https://${server}/jmap/`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${user}:${password}`)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(call),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`JMAP HTTP ${response.status}`)
    const body = await response.json() as JmapResponse
    const error = body.methodResponses.find(([name]) => name === "error")
    if (error) throw new Error(`JMAP method failed: ${JSON.stringify(error[1])}`)
    return body
  }
}

if (import.meta.main) {
  const opts = parseArgs(Deno.args)
  const admin = Deno.env.get("STALWART_ADMIN_PASSWORD")
  if (!admin) throw new Error("STALWART_ADMIN_PASSWORD is not set")
  const password = Deno.env.get(opts.passwordEnv)
  if (!password) throw new Error(`${opts.passwordEnv} is not set`)

  const { id, created } = await ensureAccount(
    jmapClient(opts.server, "admin", admin),
    opts,
    password,
  )
  console.log(`${opts.address}: ${created ? "created" : "already exists"} (id ${id})`)

  if (opts.redirect) {
    const dir = await Deno.makeTempDir()
    try {
      const sievePath = `${dir}/redirect.sieve`
      await Deno.writeTextFile(sievePath, redirectSieve(opts.redirect))
      // Sieve scripts belong to the account, so the upload logs in as it.
      await applySieve({
        apiUrl: `https://${opts.server}/jmap/`,
        user: opts.address,
        password,
        accountId: id,
        sievePath,
        scriptName: "redirect",
        skipMove: true,
        skipDeleteBounces: true,
        dryRun: false,
      })
      console.log(`${opts.address}: redirects to ${opts.redirect}`)
    } finally {
      await Deno.remove(dir, { recursive: true })
    }
  }
}
