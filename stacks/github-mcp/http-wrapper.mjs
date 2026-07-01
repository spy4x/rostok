#!/usr/bin/env node
/**
 * Streamable HTTP wrapper for github-mcp-server (Go stdio binary).
 * Spawns a child process per session and proxies JSON-RPC messages
 * between HTTP POST /mcp and the child's stdio.
 *
 * JSON-RPC notifications (no "id") are fire-and-forget — the child
 * produces no output for them, so we respond 202 immediately without
 * waiting.  Only requests with an "id" wait for a response line.
 */
import process from "node:process"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { randomBytes } from "node:crypto"

const PORT = parseInt(process.env.PORT || "3000", 10)
const CHILD_CMD = process.env.CHILD_CMD || "github-mcp-server"
const CHILD_ARGS = (process.env.CHILD_ARGS || "stdio").split(/\s+/)

// Active sessions: sessionId → { child, pendingResolve, buffer, lastUsed }
const sessions = new Map()
const SESSION_TTL_MS = 5 * 60 * 1000

setInterval(() => {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > SESSION_TTL_MS) {
      s.child.kill()
      sessions.delete(id)
    }
  }
}, 60_000)

function generateSessionId() {
  return randomBytes(16).toString("hex")
}

function spawnChild() {
  const child = spawn(CHILD_CMD, CHILD_ARGS, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  })

  const session = { child, buffer: "", pendingResolve: null, lastUsed: Date.now() }

  child.stdout.on("data", (chunk) => {
    session.buffer += chunk.toString()
    // github-mcp-server outputs one JSON-RPC message per line
    for (;;) {
      const idx = session.buffer.indexOf("\n")
      if (idx === -1) break
      const line = session.buffer.slice(0, idx).trim()
      session.buffer = session.buffer.slice(idx + 1)
      if (line && session.pendingResolve) {
        const resolve = session.pendingResolve
        session.pendingResolve = null
        resolve(line)
      }
    }
  })

  child.on("exit", () => {
    if (session.pendingResolve) {
      session.pendingResolve(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Server disconnected" },
        id: null,
      }))
      session.pendingResolve = null
    }
  })

  return session
}

/**
 * Send a JSON-RPC message to the child.
 * If it has an "id", wait for one response line and return it.
 * If it's a notification (no "id"), send and resolve immediately.
 */
function sendMessage(session, body) {
  return new Promise((resolve, reject) => {
    const isNotification = body.id === undefined || body.id === null
    session.lastUsed = Date.now()
    session.child.stdin.write(JSON.stringify(body) + "\n")

    if (isNotification) {
      resolve(null)
      return
    }

    if (session.pendingResolve) {
      reject(new Error("Prior request still pending"))
      return
    }
    session.pendingResolve = resolve
  })
}

/** Return the session for a given ID, or create+fork one. */
function getOrCreateSession(sessionId) {
  if (sessionId && sessions.has(sessionId)) {
    return { session: sessions.get(sessionId), isNew: false }
  }
  const session = spawnChild()
  const newId = generateSessionId()
  sessions.set(newId, session)
  session._id = newId
  return { session, isNew: true }
}

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id")
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id")

  if (req.method === "OPTIONS") return res.writeHead(204).end()

  // Health check
  if (req.url === "/healthz") {
    return res.writeHead(200, { "Content-Type": "text/plain" }).end("ok")
  }

  if (req.url !== "/mcp") {
    return res.writeHead(405).end(JSON.stringify({ error: "Method not allowed" }))
  }

  // GET /mcp — SSE notification stream (keepalive only, no MCP events)
  if (req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    })
    const keepalive = setInterval(() => {
      try {
        res.write(": keepalive\n\n")
      } catch {}
    }, 30000)
    req.on("close", () => {
      clearInterval(keepalive)
      try {
        res.end()
      } catch {}
    })
    return
  }

  if (req.method !== "POST") {
    return res.writeHead(405).end(JSON.stringify({ error: "Method not allowed" }))
  }

  // POST /mcp — handle JSON-RPC message
  let body = ""
  req.on("data", (chunk) => {
    body += chunk
  })
  req.on("end", async () => {
    try {
      const json = JSON.parse(body)
      const { session, isNew } = getOrCreateSession(req.headers["mcp-session-id"])

      const response = await sendMessage(session, json)

      // Set session header for new sessions or on initialize
      if (isNew || json.method === "initialize") {
        res.setHeader("Mcp-Session-Id", session._id || req.headers["mcp-session-id"])
      }

      if (response === null) {
        // Notification — no response body
        res.writeHead(202).end()
        return
      }

      const accept = req.headers.accept || ""
      if (accept.includes("text/event-stream")) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        })
        res.write(`event: message\ndata: ${response}\n\n`)
        res.end()
      } else {
        res.writeHead(200, { "Content-Type": "application/json" }).end(response)
      }
    } catch (err) {
      console.error("POST error:", err.message, "body:", body.slice(0, 200))
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: err.message },
          id: null,
        }))
      }
    }
  })
})

server.listen(PORT, () => {
  console.log(`github-mcp-server http-wrapper listening on port ${PORT}`)
})
