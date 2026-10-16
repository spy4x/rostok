// Guards the email-mcp guard: who may call the mail tools, and which tools exist at all
// (spy4x/rostok#143).

import { assert, assertEquals } from "@std/assert"
import { createGuard, MIN_TOKEN_LENGTH, USER_HEADER } from "./guard.ts"

const TOKEN = "t".repeat(MIN_TOKEN_LENGTH)
const OWNER = "owner@example.com"
const UPSTREAM = "http://upstream.test/mcp"

/** Every tool the pinned upstream image lists, with its `attachments` argument where it has one. */
const UPSTREAM_TOOLS = [
  "list_available_accounts",
  "add_email_account",
  "list_emails_metadata",
  "get_emails_content",
  "send_email",
  "save_to_mailbox",
  "delete_emails",
  "mark_emails_as_read",
  "move_emails",
  "archive_emails",
  "list_mailboxes",
  "download_attachment",
].map((name) => ({
  name,
  inputSchema: {
    type: "object",
    properties: name === "send_email" || name === "save_to_mailbox"
      ? { account_name: { type: "string" }, attachments: { type: "array" } }
      : { account_name: { type: "string" } },
    required: ["account_name"],
  },
}))

const READ_TOOLS = [
  "list_available_accounts",
  "list_emails_metadata",
  "get_emails_content",
  "list_mailboxes",
]
const CHANGE_TOOLS = [
  "send_email",
  "save_to_mailbox",
  "mark_emails_as_read",
  "move_emails",
  "archive_emails",
]

interface Upstream {
  calls: Request[]
  fetch: typeof fetch
}

/** A fake upstream that records each request and answers with `answer`. */
function fakeUpstream(answer: () => Response = () => Response.json({ ok: true })): Upstream {
  const calls: Request[] = []
  return {
    calls,
    fetch: (input, init) => {
      calls.push(new Request(input, init))
      return Promise.resolve(answer())
    },
  }
}

function guardWith(upstream: Upstream, token = TOKEN, allowedUsers = OWNER) {
  return createGuard({ token, allowedUsers, upstream: UPSTREAM, fetch: upstream.fetch })
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://hl-email-mcp:9557/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function call(name: string, args: Record<string, unknown> = {}, id = 1) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }
}

const AS_OWNER = { authorization: `Bearer ${TOKEN}`, [USER_HEADER]: OWNER }
const AS_GUEST = { authorization: `Bearer ${TOKEN}`, [USER_HEADER]: "guest@example.com" }

const toolsListAnswerJson = () =>
  Response.json({ jsonrpc: "2.0", id: 1, result: { tools: UPSTREAM_TOOLS } })

const toolsListAnswerSse = () =>
  new Response(
    `event: message\r\ndata: ${
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: UPSTREAM_TOOLS } })
    }\r\n\r\n`,
    { headers: { "content-type": "text/event-stream" } },
  )

async function errorOf(response: Response): Promise<string | undefined> {
  return (await response.json()).error?.message
}

async function toolNames(response: Response): Promise<string[]> {
  const text = await response.text()
  const json = response.headers.get("content-type")?.includes("text/event-stream")
    ? JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))!.slice(5))
    : JSON.parse(text)
  return json.result.tools.map((t: { name: string }) => t.name)
}

Deno.test("guard: refuses read, send and delete without a token, and never calls upstream", async () => {
  const upstream = fakeUpstream()
  const guard = guardWith(upstream)
  for (
    const body of [
      call("list_emails_metadata", { account_name: "main" }),
      call("send_email", { account_name: "main", recipients: ["a@example.com"] }),
      call("delete_emails", { account_name: "main", email_ids: ["1"] }),
    ]
  ) {
    const response = await guard(post(body, { [USER_HEADER]: OWNER }))
    assertEquals(response.status, 401, body.params.name)
    await response.body?.cancel()
  }
  assertEquals(upstream.calls.length, 0)
})

Deno.test("guard: refuses a wrong token, of the same length or another", async () => {
  const upstream = fakeUpstream()
  const guard = guardWith(upstream)
  for (const wrong of ["u".repeat(MIN_TOKEN_LENGTH), `${TOKEN}x`, TOKEN.slice(1), ""]) {
    const response = await guard(
      post(call("list_mailboxes", { account_name: "main" }), { authorization: `Bearer ${wrong}` }),
    )
    assertEquals(response.status, 401, wrong)
    await response.body?.cancel()
  }
  assertEquals(upstream.calls.length, 0)
})

Deno.test("guard: refuses add_email_account, delete_emails and download_attachment even for an allowed user", async () => {
  const upstream = fakeUpstream()
  const guard = guardWith(upstream)
  for (const name of ["add_email_account", "delete_emails", "download_attachment", "new_tool"]) {
    const response = await guard(post(call(name, { account_name: "main" }), AS_OWNER))
    assertEquals(response.status, 200)
    assertEquals(await errorOf(response), `tool ${name} is not offered`)
  }
  assertEquals(upstream.calls.length, 0)
})

Deno.test("guard: refuses a non-empty attachments argument on any tool, even for an allowed user", async () => {
  const upstream = fakeUpstream()
  const guard = guardWith(upstream)
  for (const name of ["send_email", "save_to_mailbox", "list_mailboxes"]) {
    for (const attachments of [["/config.toml"], "/config.toml", {}]) {
      const response = await guard(
        post(call(name, { account_name: "main", attachments }), AS_OWNER),
      )
      assertEquals(await errorOf(response), "attachments are not allowed", name)
    }
  }
  assertEquals(upstream.calls.length, 0)
})

Deno.test("guard: passes a send without attachments, or with an empty list, from an allowed user", async () => {
  const upstream = fakeUpstream()
  const guard = guardWith(upstream)
  for (const args of [{}, { attachments: [] }, { attachments: null }]) {
    const response = await guard(
      post(call("send_email", { account_name: "main", ...args }), AS_OWNER),
    )
    assertEquals(response.status, 200)
    await response.body?.cancel()
  }
  assertEquals(upstream.calls.length, 3)
})

Deno.test("guard: lets only EMAIL_MCP_ALLOWED_USERS call the tools that change mail", async () => {
  const upstream = fakeUpstream()
  const guard = guardWith(upstream, TOKEN, ` Someone@example.com , ${OWNER.toUpperCase()} `)
  for (const name of CHANGE_TOOLS) {
    for (const headers of [AS_GUEST, { authorization: `Bearer ${TOKEN}` }]) {
      const response = await guard(post(call(name, { account_name: "main" }), headers))
      assertEquals(
        await errorOf(response),
        `tool ${name} changes mail and this user may only read it`,
      )
    }
    const allowed = await guard(post(call(name, { account_name: "main" }), AS_OWNER))
    assertEquals(allowed.status, 200)
    await allowed.body?.cancel()
  }
  assertEquals(upstream.calls.length, CHANGE_TOOLS.length)
})

Deno.test("guard: lets every token holder read, but marks mail as read only for an allowed user", async () => {
  const upstream = fakeUpstream()
  const guard = guardWith(upstream)
  for (const name of READ_TOOLS) {
    const response = await guard(post(call(name, { account_name: "main" }), AS_GUEST))
    assertEquals(response.status, 200, name)
    await response.body?.cancel()
  }
  const marking = call("get_emails_content", { account_name: "main", mark_as_read: true })
  assertEquals(
    await errorOf(await guard(post(marking, AS_GUEST))),
    "mark_as_read changes mail and this user may only read it",
  )
  const owner = await guard(post(marking, AS_OWNER))
  assertEquals(owner.status, 200)
  await owner.body?.cancel()
  assertEquals(upstream.calls.length, READ_TOOLS.length + 1)
})

Deno.test("guard: with no EMAIL_MCP_ALLOWED_USERS nobody may change mail", async () => {
  const upstream = fakeUpstream()
  const guard = guardWith(upstream, TOKEN, "")
  const response = await guard(post(call("send_email", { account_name: "main" }), AS_OWNER))
  assertEquals(
    await errorOf(response),
    "tool send_email changes mail and this user may only read it",
  )
  assertEquals(upstream.calls.length, 0)
})

Deno.test("guard: tools/list in a JSON answer shows only the user's allowed tools, without attachments", async () => {
  const guard = guardWith(fakeUpstream(toolsListAnswerJson))
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" }
  assertEquals(await toolNames(await guard(post(list, AS_GUEST))), READ_TOOLS)
  const owner = await guard(post(list, AS_OWNER))
  const tools = (await owner.json()).result.tools
  assertEquals(
    tools.map((t: { name: string }) => t.name).toSorted(),
    [...READ_TOOLS, ...CHANGE_TOOLS].toSorted(),
  )
  const send = tools.find((t: { name: string }) => t.name === "send_email")
  assertEquals(Object.keys(send.inputSchema.properties), ["account_name"])
})

Deno.test("guard: tools/list in an event-stream answer shows only the user's allowed tools", async () => {
  const guard = guardWith(fakeUpstream(toolsListAnswerSse))
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list" }
  const guest = await guard(post(list, AS_GUEST))
  assertEquals(guest.headers.get("content-type"), "text/event-stream")
  assertEquals(await toolNames(guest), READ_TOOLS)
  assertEquals(
    (await toolNames(await guard(post(list, AS_OWNER)))).toSorted(),
    [...READ_TOOLS, ...CHANGE_TOOLS].toSorted(),
  )
})

Deno.test("guard: an event-stream event that does not parse is dropped, not passed on", async () => {
  const guard = guardWith(
    fakeUpstream(() =>
      new Response(`event: message\ndata: {"result":{"tools":[{"name":"delete_emails"\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    ),
  )
  const response = await guard(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, AS_OWNER))
  assertEquals(await response.text(), "")
})

Deno.test("guard: refuses a JSON-RPC batch, even of allowed calls, without calling upstream", async () => {
  const upstream = fakeUpstream()
  const guard = guardWith(upstream)
  for (
    const batch of [
      [call("list_mailboxes", { account_name: "main" }, 1), call("delete_emails", {}, 2)],
      [call("list_mailboxes", { account_name: "main" })],
    ]
  ) {
    const response = await guard(post(batch, AS_OWNER))
    assertEquals(response.status, 400)
    assertEquals(await errorOf(response), "JSON-RPC batches are not accepted")
  }
  assertEquals(upstream.calls.length, 0)
})

Deno.test("guard: refuses a body that does not parse, and anything that is not a JSON-RPC request", async () => {
  const upstream = fakeUpstream()
  const guard = guardWith(upstream)
  const cases: [unknown, number][] = [
    [`{"jsonrpc":"2.0","id":1,"method":"tools/call"`, 400],
    [`"tools/call"`, 400],
    [{ jsonrpc: "2.0", id: 1, result: {} }, 400],
    [{ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "email://main" } }, 200],
    [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { arguments: {} } }, 200],
    [{
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_mailboxes", arguments: [] },
    }, 200],
  ]
  for (const [body, status] of cases) {
    const response = await guard(post(body, AS_OWNER))
    assertEquals(response.status, status, JSON.stringify(body))
    assert((await response.json()).error, JSON.stringify(body))
  }
  assertEquals(upstream.calls.length, 0)
})

Deno.test("guard: a notification that calls a tool is checked like a request", async () => {
  const upstream = fakeUpstream()
  const guard = guardWith(upstream)
  const { id: _id, ...notification } = call("delete_emails", { account_name: "main" })
  const response = await guard(post(notification, AS_OWNER))
  assertEquals(response.status, 400)
  assertEquals(await errorOf(response), "tool delete_emails is not offered")
  assertEquals(upstream.calls.length, 0)
})

Deno.test("guard: answers 503 to everything when the token is empty or short", async () => {
  for (const token of ["", "s".repeat(MIN_TOKEN_LENGTH - 1)]) {
    const upstream = fakeUpstream()
    const guard = guardWith(upstream, token)
    const requests = [
      post(call("list_mailboxes", { account_name: "main" }), { authorization: `Bearer ${token}` }),
      post(call("list_mailboxes", { account_name: "main" })),
      new Request("http://hl-email-mcp:9557/healthz"),
    ]
    for (const request of requests) {
      const response = await guard(request)
      assertEquals(response.status, 503, `${JSON.stringify(token)} ${request.url}`)
      await response.body?.cancel()
    }
    assertEquals(upstream.calls.length, 0)
  }
})

Deno.test("guard: sends upstream the checked message, without the token or the user header", async () => {
  const upstream = fakeUpstream()
  const guard = guardWith(upstream)
  const response = await guard(
    post(
      `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_mailboxes","arguments":{"account_name":"main"}}}`,
      { ...AS_OWNER, "mcp-session-id": "session-1", cookie: "c=1" },
    ),
  )
  await response.body?.cancel()
  const [sent] = upstream.calls
  assertEquals(sent.url, UPSTREAM)
  assertEquals(sent.headers.get("authorization"), null)
  assertEquals(sent.headers.get(USER_HEADER), null)
  assertEquals(sent.headers.get("cookie"), null)
  assertEquals(sent.headers.get("mcp-session-id"), "session-1")
  assertEquals(await sent.json(), call("list_mailboxes", { account_name: "main" }))
})

Deno.test("guard: refuses GET, which would open a stream it does not filter", async () => {
  const upstream = fakeUpstream()
  const guard = guardWith(upstream)
  const response = await guard(
    new Request("http://hl-email-mcp:9557/mcp", { headers: { authorization: `Bearer ${TOKEN}` } }),
  )
  assertEquals(response.status, 405)
  await response.body?.cancel()
  assertEquals(upstream.calls.length, 0)
})
