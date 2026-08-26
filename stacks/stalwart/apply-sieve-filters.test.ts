// Tests for apply-sieve-filters. JMAP calls are mocked via a small
// in-memory store so the script's logic — argument parsing, sender
// lists, mailbox resolution, batched moves, bounce deletion — can be
// exercised without touching the real server.

import { assertEquals, assertExists, assertRejects } from "@std/assert"

import { apply, type JmapCall, type Options, parseArgs } from "./apply-sieve-filters.ts"

// In-memory mock of the JMAP API surface we touch.
interface Mailbox {
  id: string
  name: string
  parentId: string | null
  role: string | null
}
interface Email {
  id: string
  mailboxIds: Record<string, boolean>
  from?: string
  subject?: string
}
interface Blob {
  id: string
  data: string
}
interface SieveScript {
  id: string
  blobId: string
  name: string
  isActive: boolean
}

class JmapStore {
  mailboxes: Mailbox[] = []
  emails: Email[] = []
  blobs: Blob[] = []
  scripts: SieveScript[] = []
  /** Records every method call seen so tests can assert on them. */
  calls: Array<{ name: string; args: Record<string, unknown> }> = []

  constructor() {
    // Seed standard personal-account mailboxes (matches Stalwart v0.16.11
    // default for a personal account).
    this.mailboxes.push({ id: "a", name: "Inbox", parentId: null, role: "inbox" })
  }

  private nextId(prefix: string): string {
    return `${prefix}-${this.calls.length}-${Math.floor(Math.random() * 1000)}`
  }

  private findMailbox(name: string): Mailbox | undefined {
    return this.mailboxes.find((m) => m.name === name)
  }

  private findEmail(id: string): Email | undefined {
    return this.emails.find((e) => e.id === id)
  }

  private findScript(name: string): SieveScript | undefined {
    return this.scripts.find((s) => s.name === name)
  }

  private handle(call: [string, Record<string, unknown>, string]): unknown {
    const [name, args, _cid] = call
    this.calls.push({ name, args })
    switch (name) {
      case "Mailbox/query": {
        const filter = args.filter as { name?: string }
        const matches = this.mailboxes.filter((m) => filter.name ? m.name === filter.name : true)
        return { accountId: args.accountId, ids: matches.map((m) => m.id), state: "s1" }
      }
      case "Mailbox/get": {
        const ids = (args.ids as string[] | null) ?? null
        const list = ids ? this.mailboxes.filter((m) => ids.includes(m.id)) : this.mailboxes
        return { accountId: args.accountId, list, state: "s1" }
      }
      case "Mailbox/set": {
        const create = (args.create ?? {}) as Record<string, { name: string }>
        const update = (args.update ?? {}) as Record<string, Partial<Mailbox>>
        const destroy = (args.destroy ?? []) as string[]
        const created: Record<string, Mailbox> = {}
        for (const [id, spec] of Object.entries(create)) {
          const m: Mailbox = {
            id: this.nextId(spec.name.toLowerCase().slice(0, 3)),
            name: spec.name,
            parentId: null,
            role: null,
          }
          this.mailboxes.push(m)
          created[id] = m
        }
        for (const [id, patch] of Object.entries(update)) {
          const m = this.mailboxes.find((x) => x.id === id)
          if (m) Object.assign(m, patch)
        }
        for (const id of destroy) {
          this.mailboxes = this.mailboxes.filter((x) => x.id !== id)
        }
        return { accountId: args.accountId, oldState: "s1", newState: "s2", created }
      }
      case "Email/query": {
        const filter = args.filter as { from?: string; subject?: string }
        const matches = this.emails.filter((e) => {
          if (filter.from && e.from !== filter.from) return false
          if (filter.subject && e.subject !== filter.subject) return false
          return true
        })
        return { accountId: args.accountId, ids: matches.map((e) => e.id), state: "s1" }
      }
      case "Email/set": {
        const update = (args.update ?? {}) as Record<
          string,
          { mailboxIds: Record<string, boolean> }
        >
        const destroy = (args.destroy ?? []) as string[]
        const updated: Record<string, unknown> = {}
        for (const [id, patch] of Object.entries(update)) {
          const e = this.findEmail(id)
          if (!e) continue
          Object.assign(e.mailboxIds, patch.mailboxIds)
          // Replace mailboxIds entirely (per JMAP semantics — values are the full set)
          e.mailboxIds = { ...patch.mailboxIds }
          updated[id] = e.mailboxIds
        }
        for (const id of destroy) {
          this.emails = this.emails.filter((e) => e.id !== id)
        }
        return { accountId: args.accountId, oldState: "s1", newState: "s2", updated }
      }
      case "Blob/upload": {
        const create = args.create as Record<
          string,
          { data: Array<{ "data:asText": string }>; type: string }
        >
        const created: Record<string, Blob> = {}
        for (const [id, spec] of Object.entries(create)) {
          const blob: Blob = {
            id: this.nextId("blob"),
            data: spec.data[0]["data:asText"],
          }
          this.blobs.push(blob)
          created[id] = blob
        }
        return { accountId: args.accountId, created }
      }
      case "SieveScript/query": {
        const filter = (args.filter ?? {}) as { name?: string }
        const ids = this.scripts
          .filter((s) => !filter.name || s.name === filter.name)
          .map((s) => s.id)
        return { accountId: args.accountId, ids, state: "s1" }
      }
      case "SieveScript/get": {
        const ids = (args.ids as string[] | null) ?? null
        const list = ids ? this.scripts.filter((s) => ids.includes(s.id)) : this.scripts
        return { accountId: args.accountId, list, state: "s1" }
      }
      case "SieveScript/set": {
        const create = (args.create ?? {}) as Record<
          string,
          { blobId: string; name: string; isActive: boolean }
        >
        const update = (args.update ?? {}) as Record<string, Partial<SieveScript>>
        const destroy = (args.destroy ?? []) as string[]
        const created: Record<string, SieveScript> = {}
        for (const [id, spec] of Object.entries(create)) {
          const s: SieveScript = {
            id: this.nextId("sieve"),
            blobId: spec.blobId,
            name: spec.name,
            isActive: spec.isActive,
          }
          this.scripts.push(s)
          created[id] = s
        }
        for (const [id, patch] of Object.entries(update)) {
          const s = this.scripts.find((x) => x.id === id)
          if (s) {
            // Stalwart rule: cannot update isActive on a script that already
            // has isActive=true; we model that by allowing the update and
            // toggling the flag.
            if (patch.isActive !== undefined) s.isActive = patch.isActive
          }
        }
        for (const id of destroy) {
          this.scripts = this.scripts.filter((s) => s.id !== id)
        }
        return { accountId: args.accountId, oldState: "s1", newState: "s2", created }
      }
      default:
        throw new Error(`mock: unknown method ${name}`)
    }
  }

  /** Reply handler that processes every call in a batch sequentially.
   *  Returns the JMAP methodResponses shape: [[name, result, callId], ...]. */
  handleBatch(batch: Array<[string, Record<string, unknown>, string]>): unknown[] {
    return batch.map(([name, _args, callId]) => [name, this.handle([name, _args, callId]), callId])
  }

  /** Add a synthetic email to the store. */
  addEmail(e: Omit<Email, "id" | "mailboxIds">): string {
    const id = this.nextId("email")
    this.emails.push({ ...e, id, mailboxIds: { a: true } })
    return id
  }

  /** Total count of JMAP method calls handled so far. */
  get callCount(): number {
    return this.calls.length
  }
}

/**
 * Inject the mock store into the apply-sieve-filters module.
 * Returns a restore() that undoes the injection — useful for cleanup.
 */
function withMockedFetch(store: JmapStore): () => void {
  const originalFetch = globalThis.fetch // deno-lint-ignore no-explicit-any
  ;(globalThis as any).fetch = async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (!url.includes("/jmap/")) {
      // Pass through to the real fetch for non-JMAP requests (e.g. local file reads).
      return originalFetch(input as Request, init)
    }
    const body = init?.body
    if (typeof body !== "string") {
      throw new Error("mock: JMAP request body must be a string")
    }
    const req = JSON.parse(body) as JmapCall
    const responses = store.handleBatch(req.methodCalls)
    return new Response(JSON.stringify({ methodResponses: responses, sessionState: "s1" }), {
      headers: { "Content-Type": "application/json" },
    })
  }
  return () => {
    globalThis.fetch = originalFetch
  }
}

const SIEVE_BODY = `require ["fileinto", "mailbox"];
if anyof (address :is "from" "noreply-dmarc-support@google.com") {
  fileinto "Reports";
  stop;
}`

const baseOpts: Options = {
  apiUrl: "https://example.invalid/jmap/",
  user: "u@example.com",
  password: "p",
  accountId: "acc",
  sievePath: "/tmp/example.sieve",
  scriptName: "filters",
  skipMove: false,
  skipDeleteBounces: false,
  dryRun: false,
}

Deno.test("parseArgs picks up CLI flags", () => {
  const parsed = parseArgs([
    "--api-url",
    "https://m.example/jmap/",
    "--user",
    "u@e.com",
    "--password",
    "pw",
    "--account-id",
    "a1",
    "--name",
    "noise",
    "--sieve",
    "/tmp/x.sieve",
    "--dry-run",
  ])
  assertEquals(parsed.apiUrl, "https://m.example/jmap/")
  assertEquals(parsed.user, "u@e.com")
  assertEquals(parsed.password, "pw")
  assertEquals(parsed.accountId, "a1")
  assertEquals(parsed.scriptName, "noise")
  assertEquals(parsed.sievePath, "/tmp/x.sieve")
  assertEquals(parsed.dryRun, true)
})

Deno.test("apply creates script and activates it", async () => {
  const store = new JmapStore()
  const restore = withMockedFetch(store)
  try {
    const path = await Deno.makeTempFile({ suffix: ".sieve" })
    await Deno.writeTextFile(path, SIEVE_BODY)
    await apply({ ...baseOpts, sievePath: path })
    const scripts = store.scripts.filter((s) => s.isActive)
    assertEquals(scripts.length, 1)
    const s = scripts[0]
    assertEquals(s.name, "filters")
    assertExists(store.blobs.find((b) => b.id === s.blobId))
  } finally {
    restore()
  }
})

Deno.test("apply replaces existing script: deactivate, destroy, create", async () => {
  const store = new JmapStore()
  const restore = withMockedFetch(store)
  try {
    // Seed an existing active script
    store.scripts.push({
      id: "old",
      blobId: "oldblob",
      name: "filters",
      isActive: true,
    })

    const path = await Deno.makeTempFile({ suffix: ".sieve" })
    await Deno.writeTextFile(path, SIEVE_BODY)
    await apply({ ...baseOpts, sievePath: path })

    // Old gone, exactly one active remains
    assertEquals(store.scripts.find((s) => s.id === "old"), undefined)
    assertEquals(store.scripts.filter((s) => s.isActive).length, 1)
    assertEquals(store.scripts.filter((s) => s.isActive)[0].name, "filters")
  } finally {
    restore()
  }
})

Deno.test("apply ensures the three target folders exist", async () => {
  const store = new JmapStore()
  const restore = withMockedFetch(store)
  try {
    const path = await Deno.makeTempFile({ suffix: ".sieve" })
    await Deno.writeTextFile(path, SIEVE_BODY)
    await apply({ ...baseOpts, sievePath: path })
    const names = store.mailboxes.map((m) => m.name).sort()
    assertEquals(names, ["Digests", "Inbox", "Reports", "VCB"])
  } finally {
    restore()
  }
})

Deno.test("apply bulk-moves existing matching messages", async () => {
  const store = new JmapStore()
  const restore = withMockedFetch(store)
  try {
    // Seed messages with various senders + subjects
    store.addEmail({ from: "noreply-dmarc-support@google.com", subject: "report" })
    store.addEmail({ from: "noreply-dmarc-support@google.com", subject: "another" })
    store.addEmail({ from: "info@info.vietcombank.com.vn", subject: "thong bao" })
    store.addEmail({ from: "noreply@mail.selfh.st", subject: "Self-Host Weekly 24" })
    store.addEmail({ from: "billing@ic.vrn.ru", subject: "invoice" })
    store.addEmail({ from: "alex@gmail.com", subject: "Hi" }) // should stay in INBOX
    store.addEmail({ from: "noreply@wise.com", subject: "Transfer received" }) // wise is intentionally absent

    const path = await Deno.makeTempFile({ suffix: ".sieve" })
    await Deno.writeTextFile(path, SIEVE_BODY)
    await apply({ ...baseOpts, sievePath: path })

    const inReports = store.emails.filter((e) =>
      e.mailboxIds[
        store.mailboxes.find((m) => m.name === "Reports")!.id
      ]
    ).length
    const inVcb = store.emails.filter((e) =>
      e.mailboxIds[store.mailboxes.find((m) => m.name === "VCB")!.id]
    ).length
    const inDigests = store.emails.filter((e) =>
      e.mailboxIds[
        store.mailboxes.find((m) => m.name === "Digests")!.id
      ]
    ).length
    const inInbox = store.emails.filter((e) => e.mailboxIds["a"]).length

    assertEquals(inReports, 2)
    assertEquals(inVcb, 1)
    assertEquals(inDigests, 2) // selfh.st + billing@ic.vrn.ru (both via digests)
    assertEquals(inInbox, 2) // personal + wise stays in INBOX
  } finally {
    restore()
  }
})

Deno.test("apply deletes mailer-daemon bounces", async () => {
  const store = new JmapStore()
  const restore = withMockedFetch(store)
  try {
    store.addEmail({ from: "mailer-daemon@googlemail.com", subject: "DSN" })
    store.addEmail({ from: "mailer-daemon@googlemail.com", subject: "DSN" })
    store.addEmail({ from: "alex@gmail.com", subject: "Hi" })

    const path = await Deno.makeTempFile({ suffix: ".sieve" })
    await Deno.writeTextFile(path, SIEVE_BODY)
    await apply({ ...baseOpts, sievePath: path })

    assertEquals(store.emails.length, 1)
    assertEquals(store.emails[0].from, "alex@gmail.com")
  } finally {
    restore()
  }
})

Deno.test("dry-run skips move/cleanup phases", async () => {
  const store = new JmapStore()
  const restore = withMockedFetch(store)
  try {
    store.addEmail({ from: "mailer-daemon@googlemail.com", subject: "DSN" })
    store.addEmail({ from: "noreply@mail.selfh.st", subject: "Self-Host Weekly" })
    const beforeBounceCount = store.emails.filter((e) =>
      e.from === "mailer-daemon@googlemail.com"
    ).length
    const beforeInbox = store.emails.length

    const path = await Deno.makeTempFile({ suffix: ".sieve" })
    await Deno.writeTextFile(path, SIEVE_BODY)
    await apply({ ...baseOpts, sievePath: path, dryRun: true })

    // Nothing moved or deleted in dry-run
    assertEquals(store.emails.length, beforeInbox)
    assertEquals(
      store.emails.filter((e) => e.from === "mailer-daemon@googlemail.com").length,
      beforeBounceCount,
    )
  } finally {
    restore()
  }
})

Deno.test("--skip-move and --skip-delete-bounces honored", async () => {
  const store = new JmapStore()
  const restore = withMockedFetch(store)
  try {
    store.addEmail({ from: "noreply@mail.selfh.st", subject: "Weekly" })
    store.addEmail({ from: "mailer-daemon@googlemail.com", subject: "DSN" })

    const path = await Deno.makeTempFile({ suffix: ".sieve" })
    await Deno.writeTextFile(path, SIEVE_BODY)
    await apply({
      ...baseOpts,
      sievePath: path,
      skipMove: true,
      skipDeleteBounces: true,
    })

    // Bounce stays, digest still in INBOX (script never ran the move/cleanup)
    assertEquals(store.emails.filter((e) => e.from === "mailer-daemon@googlemail.com").length, 1)
    assertEquals(store.emails.filter((e) => e.mailboxIds["a"]).length, 2)
  } finally {
    restore()
  }
})

Deno.test("apply errors when user/password missing", async () => {
  await assertRejects(
    () => apply({ ...baseOpts, user: "", password: "", accountId: "" }),
    Error,
    "required",
  )
})
