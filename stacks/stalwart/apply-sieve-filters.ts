// Apply Sieve auto-folder rules to a Stalwart mailbox.
//
// Reads ./example.sieve (or a path supplied via --sieve), uploads it as
// a JMAP Blob, then atomically deactivates + destroys + recreates the
// "filters" SieveScript on the given account. After it returns, all
// new mail arriving on that account is filtered by the script.
//
// Optionally also bulk-moves existing matching messages from INBOX into
// the new folders and deletes bounce messages from mailer-daemon@googlemail.com
// (Stalwart used to forward DMARC forensic reports to dmarc@investing.com —
// that group doesn't exist, so the bounces land in INBOX).
//
// Usage:
//   deno run -A ./stacks/stalwart/apply-sieve-filters.ts \
//     --api-url https://mail.antonshubin.com/jmap/ \
//     --user "anton@antonshubin.com" \
//     --password "$EMAIL_MCP_PERSONAL_PASSWORD" \
//     --account-id b
//
// Or set EMAIL_MCP_PERSONAL_PASSWORD and EMAIL_MCP_NEATSOFT_PASSWORD in
// the env and the --password flag can be omitted.

export interface Options {
  apiUrl: string
  user: string
  password: string
  accountId: string
  sievePath: string
  scriptName: string
  skipMove: boolean
  skipDeleteBounces: boolean
  dryRun: boolean
}

export interface JmapCall {
  using: string[]
  methodCalls: Array<[string, Record<string, unknown>, string]>
}

export function parseArgs(args: string[]): Options {
  const opts: Record<string, string | boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith("--")) continue
    const key = a.slice(2)
    const next = args[i + 1]
    if (!next || next.startsWith("--")) {
      opts[key] = true
    } else {
      opts[key] = next
      i++
    }
  }

  // Resolve password from env if not given. Pick the one matching --user
  // when possible.
  let password = opts["password"] as string | undefined
  if (!password) {
    const user = opts["user"] as string
    if (user) {
      if (user.startsWith("anton@antonshubin")) {
        password = Deno.env.get("EMAIL_MCP_PERSONAL_PASSWORD")
      } else if (user.startsWith("anton@neatsoft")) {
        password = Deno.env.get("EMAIL_MCP_NEATSOFT_PASSWORD")
      }
    }
    if (!password) password = Deno.env.get("STALWART_ADMIN_PASSWORD")
  }

  return {
    apiUrl: (opts["api-url"] as string) ?? Deno.env.get("STALWART_API_URL") ??
      "https://mail.antonshubin.com/jmap/",
    user: (opts["user"] as string) ?? "",
    password: password ?? "",
    accountId: (opts["account-id"] as string) ?? "",
    sievePath: (opts["sieve"] as string) ?? "./example.sieve",
    scriptName: (opts["name"] as string) ?? "filters",
    skipMove: !!opts["skip-move"],
    skipDeleteBounces: !!opts["skip-delete-bounces"],
    dryRun: !!opts["dry-run"],
  }
}

function call(
  name: string,
  args: Record<string, unknown>,
  cid: string,
): [string, Record<string, unknown>, string] {
  return [name, args, cid]
}

async function jmap(opts: Options, body: JmapCall): Promise<unknown> {
  const req = await fetch(opts.apiUrl, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(`${opts.user}:${opts.password}`),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  if (!req.ok) {
    const text = await req.text()
    throw new Error(`JMAP ${body.methodCalls[0]?.[0]} HTTP ${req.status}: ${text}`)
  }
  return await req.json()
}

const USING_ALL = [
  "urn:ietf:params:jmap:core",
  "urn:ietf:params:jmap:mail",
  "urn:ietf:params:jmap:blob",
  "urn:ietf:params:jmap:sieve",
]

/**
 * Build the JMAP method-call batches for one apply pass. Splitting into
 * three phases (upload, swap, move+cleanup) lets us fail early on a
 * bad script without leaving a half-deactivated state behind.
 */
export async function apply(opts: Options): Promise<void> {
  if (!opts.user || !opts.password || !opts.accountId) {
    throw new Error("--user, --password (or env), and --account-id are required")
  }
  const sieveText = await Deno.readTextFile(opts.sievePath)

  // Phase 1 — find existing script ids (by name) and upload the new blob.
  console.log("=== Uploading script ===")
  const queryResp = (await jmap(opts, {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:sieve"],
    methodCalls: [
      call(
        "SieveScript/query",
        { accountId: opts.accountId, filter: { name: opts.scriptName } },
        "q",
      ),
    ],
  })) as {
    methodResponses: Array<[string, { ids: string[] }]>
  }
  const existing = queryResp.methodResponses[0][1].ids
  console.log(`  existing scripts with name '${opts.scriptName}': ${existing}`)

  const uploadResp = (await jmap(opts, {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:blob"],
    methodCalls: [
      call(
        "Blob/upload",
        {
          accountId: opts.accountId,
          create: {
            s1: {
              data: [{ "data:asText": sieveText }],
              type: "text/plain",
            },
          },
        },
        "u",
      ),
    ],
  })) as {
    methodResponses: Array<[string, { created: Record<string, { id: string }> }]>
  }
  const blobId = uploadResp.methodResponses[0][1].created.s1.id
  console.log(`  blob id: ${blobId}`)

  // Phase 2 — deactivate + destroy old, create new active.
  console.log("\n=== Replacing SieveScript ===")
  if (opts.dryRun) {
    console.log("  (dry-run: would deactivate + destroy + create; skipping)")
    return
  }
  const setCalls = [
    ...existing.map((sid) =>
      call(
        "SieveScript/set",
        { accountId: opts.accountId, update: { [sid]: { isActive: false } } },
        `deactivate-${sid}`,
      )
    ),
    ...existing.map((sid) =>
      call(
        "SieveScript/set",
        { accountId: opts.accountId, destroy: [sid] },
        `destroy-${sid}`,
      )
    ),
    call(
      "SieveScript/set",
      {
        accountId: opts.accountId,
        create: {
          [opts.scriptName]: {
            blobId,
            name: opts.scriptName,
            isActive: true,
          },
        },
      },
      "create",
    ),
  ]
  const setResp = (await jmap(opts, {
    using: USING_ALL,
    methodCalls: setCalls,
  })) as { methodResponses: Array<[string, unknown]> }
  for (let i = 0; i < setResp.methodResponses.length; i++) {
    console.log(`  call ${i}: ${JSON.stringify(setResp.methodResponses[i][1]).slice(0, 200)}`)
  }

  // Phase 3 — bulk-move existing matching messages. Uses sender-based
  // filters for Reports/VCB and subject-keyword filters for Digests.
  // For Digests we also match the explicit billing@ic.vrn.ru address.
  if (!opts.skipMove || !opts.skipDeleteBounces) {
    console.log("\n=== Moving existing messages ===")
    await runMove(opts)
  }

  if (!opts.skipDeleteBounces) {
    console.log("\n=== Deleting bounces ===")
    await runDeleteBounces(opts)
  }
}

const REPORT_SENDERS = [
  "noreply-dmarc-support@google.com",
  "noreply-smtp-tls-reporting@google.com",
  "postmaster@amazonses.com",
  "dmarc_support@corp.mail.ru",
]

const VCB_SENDERS = [
  "info@info.vietcombank.com.vn",
  "VCBDigibank@info.vietcombank.com.vn",
]

const DIGEST_SENDERS = [
  "noreply@mail.selfh.st",
  "informer@daily.dev",
  "jsw@peterc.org",
  "node@cooperpress.com",
  "postgres@cooperpress.com",
  "newsletter@nodeweekly.com",
  "do-not-reply@singlife.com",
  "no-reply@agoda.com",
  "noreply@simba.sg",
  "no_reply@immigration.gov.vn",
  "no-reply@grab.com",
  "dvc_bca@noreply.vnpay.vn",
]

const DIGEST_EXPLICIT_FROM = [
  "billing@ic.vrn.ru",
]

const DIGEST_SUBJECT_KEYWORDS = [
  "weekly",
  "digest",
  "newsletter",
  "roundup",
  "meetup",
]

/**
 * Resolve the IDs of the three folders the script writes to. Creates them
 * if missing — safe to run repeatedly.
 */
async function ensureMailboxes(
  opts: Options,
): Promise<{ reports: string; vcb: string; digests: string }> {
  // Reuse if all three exist; create the rest idempotently.
  const query = async (name: string) => {
    const r = (await jmap(opts, {
      using: USING_ALL,
      methodCalls: [
        call(
          "Mailbox/query",
          { accountId: opts.accountId, filter: { name } },
          `q-${name}`,
        ),
      ],
    })) as { methodResponses: Array<[string, { ids: string[] }]> }
    return r.methodResponses[0][1].ids[0]
  }
  const reportsId = await query("Reports")
  const vcbId = await query("VCB")
  const digestsId = await query("Digests")

  const create: Record<string, { name: string }> = {}
  if (!reportsId) create.r1 = { name: "Reports" }
  if (!vcbId) create.v1 = { name: "VCB" }
  if (!digestsId) create.d1 = { name: "Digests" }
  if (Object.keys(create).length > 0) {
    await jmap(opts, {
      using: USING_ALL,
      methodCalls: [
        call("Mailbox/set", { accountId: opts.accountId, create }, "mb-create"),
      ],
    })
  }
  return {
    reports: reportsId ?? (await query("Reports")),
    vcb: vcbId ?? (await query("VCB")),
    digests: digestsId ?? (await query("Digests")),
  }
}

async function queryIds(opts: Options, filter: Record<string, unknown>): Promise<string[]> {
  const resp = (await jmap(opts, {
    using: USING_ALL,
    methodCalls: [call("Email/query", { accountId: opts.accountId, filter, limit: 100 }, "q")],
  })) as { methodResponses: Array<[string, { ids: string[] }]> }
  return resp.methodResponses[0][1].ids
}

async function runMove(opts: Options): Promise<void> {
  const ids = await ensureMailboxes(opts)

  const moves: Array<{ id: string; mailbox: string }> = []

  for (const from of REPORT_SENDERS) {
    for (const id of await queryIds(opts, { from })) {
      moves.push({ id, mailbox: ids.reports })
    }
  }
  for (const from of VCB_SENDERS) {
    for (const id of await queryIds(opts, { from })) {
      moves.push({ id, mailbox: ids.vcb })
    }
  }
  for (const from of DIGEST_SENDERS) {
    for (const id of await queryIds(opts, { from })) {
      moves.push({ id, mailbox: ids.digests })
    }
  }
  for (const from of DIGEST_EXPLICIT_FROM) {
    for (const id of await queryIds(opts, { from })) {
      moves.push({ id, mailbox: ids.digests })
    }
  }
  for (const subject of DIGEST_SUBJECT_KEYWORDS) {
    for (const id of await queryIds(opts, { subject })) {
      moves.push({ id, mailbox: ids.digests })
    }
  }

  // Dedupe
  const seen = new Set<string>()
  const unique = moves.filter((m) => seen.has(m.id) ? false : (seen.add(m.id), true))

  console.log(`  total to move: ${unique.length}`)
  // Batch in groups of 50 (JMAP URL length safety)
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50)
    const update: Record<string, { mailboxIds: Record<string, boolean> }> = {}
    for (const m of batch) {
      update[m.id] = { mailboxIds: { [m.mailbox]: true } }
    }
    await jmap(opts, {
      using: USING_ALL,
      methodCalls: [
        call("Email/set", { accountId: opts.accountId, update }, `m-${i}`),
      ],
    })
    console.log(`  moved ${i}-${i + batch.length}`)
  }
}

async function runDeleteBounces(opts: Options): Promise<void> {
  const ids = await queryIds(opts, { from: "mailer-daemon@googlemail.com" })
  if (ids.length === 0) {
    console.log("  no bounces")
    return
  }
  await jmap(opts, {
    using: USING_ALL,
    methodCalls: [
      call("Email/set", { accountId: opts.accountId, destroy: ids }, "d-bounces"),
    ],
  })
  console.log(`  deleted ${ids.length} bounces`)
}

if (import.meta.main) {
  const opts = parseArgs(Deno.args)
  await apply(opts)
}
