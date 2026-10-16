// The guard in front of mcp-email-server, which has no authentication of its own
// (spy4x/rostok#143). Open WebUI calls it as http://hl-email-mcp:9557/mcp; it forwards what it
// allows to the upstream server on a network only the two of them share.
//
// What it enforces, on every request:
// - a bearer token (EMAIL_MCP_TOKEN), compared in constant time. With no token, or one shorter
//   than MIN_TOKEN_LENGTH, it answers 503 to everything: it never runs open;
// - a tool allowlist, deny by default. `tools/list` answers show only the allowed tools, and
//   `tools/call` for any other tool is refused with a JSON-RPC error. Never allowed:
//   add_email_account, delete_emails (it expunges: no Trash), download_attachment (writes to the
//   container's disk), and any `attachments` argument (it reads files from the container's disk,
//   the mailbox password among them);
// - per-user authorization: the tools that change mail run only for the Open WebUI accounts in
//   EMAIL_MCP_ALLOWED_USERS, read from the X-OpenWebUI-User-Email header that Open WebUI's
//   connection sends. The header is trusted only because the token proved the caller is Open
//   WebUI;
// - only the JSON-RPC methods a tool client needs. Batches, other methods and bodies that do not
//   parse are refused. Upstream receives the message the guard checked, serialized again, so it
//   can never read the body differently from the guard.
//
// Web standards only, so the handler runs on any runtime. `+main.ts` reads the settings and is
// what `deno serve` runs.

/** Tools that only read. Every token holder may call them. */
const READ_TOOLS = new Set([
  "list_available_accounts",
  "list_mailboxes",
  "list_emails_metadata",
  "get_emails_content",
])

/**
 * Tools that change mail or send it. Only the users in EMAIL_MCP_ALLOWED_USERS may call them.
 * A message to remove goes to Trash with move_emails (or out of the inbox with archive_emails), so
 * the mail server's Trash is the recovery window; delete_emails is never offered.
 */
const CHANGE_TOOLS = new Set([
  "send_email",
  "save_to_mailbox",
  "move_emails",
  "archive_emails",
  "mark_emails_as_read",
])

/** JSON-RPC methods a tool client needs. Everything else (resources, prompts, ...) is refused. */
const ALLOWED_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "ping",
  "tools/list",
  "tools/call",
])

/** `generatePassword(32)` makes the token; a shorter one is a mistake, so the guard stays shut. */
export const MIN_TOKEN_LENGTH = 32

/** Larger request bodies are refused: a tool call is a few kilobytes. */
const MAX_BODY_BYTES = 1024 * 1024

/** The header Open WebUI's connection fills with the signed-in user's e-mail address. */
export const USER_HEADER = "x-openwebui-user-email"

/** Request headers passed to upstream; the token and every other header stay here. */
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
]

/** Response headers passed back to the client. */
const FORWARDED_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "cache-control"]

/** JSON-RPC error codes the guard answers with. */
enum RpcError {
  ParseError = -32700,
  InvalidRequest = -32600,
  MethodNotFound = -32601,
  InvalidParams = -32602,
}

/** What the guard needs to run. */
export interface GuardConfig {
  /** The bearer token callers must send. Empty or short: every request gets 503. */
  token: string
  /** Comma-separated Open WebUI e-mail addresses that may use the tools that change mail. */
  allowedUsers: string
  /** The upstream MCP endpoint, e.g. http://hl-email-mcp-upstream:9557/mcp. */
  upstream: string
  /** The fetch used to reach upstream; tests pass a fake one. */
  fetch?: typeof fetch
}

interface RpcMessage {
  jsonrpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

/** A JSON-RPC error answer. A request with an id gets 200, as JSON-RPC expects; anything else 400. */
function rpcError(message: RpcMessage | null, code: RpcError, text: string): Response {
  const hasId = message !== null && "id" in message && message.id !== undefined
  return jsonResponse(hasId ? 200 : 400, {
    jsonrpc: "2.0",
    id: hasId ? message.id : null,
    error: { code, message: text },
  })
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
}

/**
 * Compares two strings in time that does not depend on where they differ, or on their lengths:
 * both are hashed to 32 bytes first, and every byte is compared.
 */
async function sameSecret(given: string, expectedDigest: Uint8Array): Promise<boolean> {
  const digest = await sha256(given)
  let diff = 0
  for (let i = 0; i < digest.length; i++) diff |= digest[i] ^ expectedDigest[i]
  return diff === 0
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** An `attachments` argument counts as empty only when absent, null or `[]`. */
function hasAttachments(args: Record<string, unknown>): boolean {
  if (!("attachments" in args)) return false
  const value = args.attachments
  return !(value === null || value === undefined || (Array.isArray(value) && value.length === 0))
}

/** Why a `tools/call` is refused, or null when it may run. */
export function refuseToolCall(
  name: string,
  args: Record<string, unknown>,
  userMayChange: boolean,
): string | null {
  if (hasAttachments(args)) return `attachments are not allowed`
  if (CHANGE_TOOLS.has(name)) {
    return userMayChange ? null : `tool ${name} changes mail and this user may only read it`
  }
  if (!READ_TOOLS.has(name)) return `tool ${name} is not offered`
  // Reading with mark_as_read changes the message's flags.
  if (name === "get_emails_content" && args.mark_as_read && !userMayChange) {
    return `mark_as_read changes mail and this user may only read it`
  }
  return null
}

/** The tools a user may see in `tools/list`, without the `attachments` argument. */
function filterTools(tools: Json[], userMayChange: boolean): Json[] {
  return tools.flatMap((tool) => {
    if (!isObject(tool) || typeof tool.name !== "string") return []
    if (!READ_TOOLS.has(tool.name) && !(userMayChange && CHANGE_TOOLS.has(tool.name))) return []
    const schema = tool.inputSchema
    if (!isObject(schema) || !isObject(schema.properties)) return [tool]
    const { attachments: _dropped, ...properties } = schema.properties
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key) => key !== "attachments")
      : schema.required
    return [{ ...tool, inputSchema: { ...schema, properties, required } } as Json]
  })
}

/** Filters every `tools/list` result in one parsed message. */
function filterMessage(message: Json, userMayChange: boolean): Json {
  if (!isObject(message) || !isObject(message.result) || !("tools" in message.result)) {
    return message
  }
  const tools = Array.isArray(message.result.tools) ? message.result.tools : []
  return { ...message, result: { ...message.result, tools: filterTools(tools, userMayChange) } }
}

/**
 * Rewrites a `text/event-stream` body: each event's data is parsed and filtered. An event whose
 * data does not parse is dropped, so nothing unfiltered gets through.
 */
export function filterEventStream(body: string, userMayChange: boolean): string {
  const events = body.split(/\r?\n\r?\n/)
  const out: string[] = []
  for (const event of events) {
    if (event.trim() === "") continue
    const lines = event.split(/\r?\n/)
    const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart())
    const other = lines.filter((l) => !l.startsWith("data:"))
    if (data.length === 0) {
      out.push(event)
      continue
    }
    let parsed: Json
    try {
      parsed = JSON.parse(data.join("\n"))
    } catch {
      continue
    }
    out.push([...other, `data: ${JSON.stringify(filterMessage(parsed, userMayChange))}`].join("\n"))
  }
  return out.map((e) => `${e}\n\n`).join("")
}

async function readLimited(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (declared > MAX_BODY_BYTES) return null
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length > MAX_BODY_BYTES) return null
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

/** Builds the guard's request handler from its configuration. */
export function createGuard(config: GuardConfig): (request: Request) => Promise<Response> {
  const upstreamFetch = config.fetch ?? fetch
  const configured = config.token.length >= MIN_TOKEN_LENGTH
  const tokenDigest = sha256(config.token)
  const allowedUsers = new Set(
    config.allowedUsers.split(",").map((u) => u.trim().toLowerCase()).filter((u) => u !== ""),
  )

  function forwardHeaders(from: Headers, names: string[]): Headers {
    const headers = new Headers()
    for (const name of names) {
      const value = from.get(name)
      if (value !== null) headers.set(name, value)
    }
    return headers
  }

  async function forward(request: Request, body?: string): Promise<Response> {
    try {
      return await upstreamFetch(config.upstream, {
        method: request.method,
        headers: forwardHeaders(request.headers, FORWARDED_REQUEST_HEADERS),
        body,
        redirect: "manual",
      })
    } catch {
      return jsonResponse(502, { error: "upstream unreachable" })
    }
  }

  function passBack(upstream: Response, body: BodyInit | null): Response {
    return new Response(body, {
      status: upstream.status,
      headers: forwardHeaders(upstream.headers, FORWARDED_RESPONSE_HEADERS),
    })
  }

  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname
    if (path === "/healthz") {
      return new Response(configured ? "ok" : "token missing or too short", {
        status: configured ? 200 : 503,
      })
    }
    if (!configured) return jsonResponse(503, { error: "guard has no valid EMAIL_MCP_TOKEN" })
    if (path !== "/mcp") return jsonResponse(404, { error: "not found" })

    const auth = request.headers.get("authorization") ?? ""
    const match = /^Bearer (.+)$/.exec(auth)
    if (!match || !(await sameSecret(match[1], await tokenDigest))) {
      return jsonResponse(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" })
    }

    const user = (request.headers.get(USER_HEADER) ?? "").trim().toLowerCase()
    const userMayChange = user !== "" && allowedUsers.has(user)

    if (request.method === "DELETE") {
      const upstream = await forward(request)
      return passBack(upstream, upstream.body)
    }
    if (request.method !== "POST") {
      return jsonResponse(405, { error: "method not allowed" }, { allow: "POST, DELETE" })
    }
    if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
      return jsonResponse(415, { error: "content-type must be application/json" })
    }

    let text: string | null
    try {
      text = await readLimited(request)
    } catch {
      return rpcError(null, RpcError.ParseError, "body is not valid UTF-8")
    }
    if (text === null) return jsonResponse(413, { error: "body too large" })

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return rpcError(null, RpcError.ParseError, "body is not valid JSON")
    }
    if (Array.isArray(parsed)) {
      return rpcError(null, RpcError.InvalidRequest, "JSON-RPC batches are not accepted")
    }
    if (!isObject(parsed) || parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") {
      return rpcError(null, RpcError.InvalidRequest, "not a JSON-RPC 2.0 request")
    }
    const message: RpcMessage = parsed
    const method = parsed.method
    if (!ALLOWED_METHODS.has(method)) {
      return rpcError(message, RpcError.MethodNotFound, `method ${method} is not offered`)
    }
    if (method === "tools/call") {
      const params = parsed.params
      if (!isObject(params) || typeof params.name !== "string") {
        return rpcError(message, RpcError.InvalidParams, "tools/call needs a tool name")
      }
      const args = params.arguments ?? {}
      if (!isObject(args)) {
        return rpcError(message, RpcError.InvalidParams, "tool arguments must be an object")
      }
      const refusal = refuseToolCall(params.name, args, userMayChange)
      if (refusal) return rpcError(message, RpcError.InvalidParams, refusal)
    }

    const upstream = await forward(request, JSON.stringify(parsed))
    if (method !== "tools/list") return passBack(upstream, upstream.body)

    const contentType = upstream.headers.get("content-type") ?? ""
    const body = await upstream.text()
    if (contentType.includes("text/event-stream")) {
      return passBack(upstream, filterEventStream(body, userMayChange))
    }
    if (body === "") return passBack(upstream, null)
    try {
      return passBack(upstream, JSON.stringify(filterMessage(JSON.parse(body), userMayChange)))
    } catch {
      return jsonResponse(502, { error: "upstream answered with a body that does not parse" })
    }
  }
}
