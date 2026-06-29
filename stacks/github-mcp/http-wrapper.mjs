#!/usr/bin/env node
/**
 * Streamable HTTP wrapper for github-mcp-server (Go stdio binary).
 * Spawns a child process per session and proxies JSON-RPC messages
 * between HTTP POST /mcp and the child's stdio.
 *
 * OpenWebUI connects via TOOL_SERVER_CONNECTIONS as type "mcp".
 */
import process from "node:process"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { randomBytes } from "node:crypto"

const PORT = parseInt(process.env.PORT || "3000", 10)
const CHILD_CMD = process.env.CHILD_CMD || "github-mcp-server"
const CHILD_ARGS = (process.env.CHILD_ARGS || "stdio").split(/\s+/)

// Active sessions: sessionId → { child, buffer, lastUsed }
const sessions = new Map()
const SESSION_TTL_MS = 5 * 60 * 1000 // 5 min idle timeout

// Periodic cleanup of stale sessions
setInterval(() => {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now - session.lastUsed > SESSION_TTL_MS) {
      session.child.kill()
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
    env: {
      ...process.env,
      // GITHUB_PERSONAL_ACCESS_TOKEN is passed from compose env
    },
  })

  const session = { child, buffer: "", pendingResolve: null }

  child.stdout.on("data", (chunk) => {
    session.buffer += chunk.toString()
    // github-mcp-server outputs one JSON-RPC message per line
    const idx = session.buffer.indexOf("\n")
    if (idx !== -1) {
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

/** Send a JSON-RPC message to the child and wait for one response line */
function sendMessage(session, body) {
  return new Promise((resolve, reject) => {
    // If there's already buffered data, try to parse it first
    if (session.pendingResolve) {
      reject(new Error("Previous request still pending"))
      return
    }
    session.pendingResolve = resolve
    session.child.stdin.write(JSON.stringify(body) + "\n")
    session.lastUsed = Date.now()
  })
}

const server = createServer((req, res) => {
  // CORS headers (allow all origins for MCP)
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id")
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id")

  if (req.method === "OPTIONS") {
    res.writeHead(204)
    res.end()
    return
  }

  // Health check (HEAD or GET — wget --spider sends HEAD)
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" })
    res.end("ok")
    return
  }

  // MCP endpoint — accept GET (stream check) and POST (requests)
  if (req.url === "/mcp") {
    if (req.method === "GET") {
      // Streamable HTTP GET — OpenWebUI uses this for server-sent events / notifications
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      })
      // Send keepalive every 30s
      const keepalive = setInterval(() => res.write(": keepalive\n\n"), 30000)
      req.on("close", () => {
        clearInterval(keepalive)
        res.end()
      })
      return
    }
    if (req.method !== "POST") {
      res.writeHead(405)
      res.end(JSON.stringify({ error: "Method not allowed" }))
      return
    }
  } else {
    res.writeHead(405)
    res.end(JSON.stringify({ error: "Method not allowed" }))
    return
  }

  let body = ""
  req.on("data", (chunk) => {
    body += chunk
  })
  req.on("end", async () => {
    try {
      const json = JSON.parse(body)
      const sessionId = req.headers["mcp-session-id"]

      let session
      if (sessionId && sessions.has(sessionId)) {
        session = sessions.get(sessionId)
      } else {
        // New session — spawn a child
        session = spawnChild()
        const newSessionId = generateSessionId()
        sessions.set(newSessionId, session)
        // Tag the session with its ID for response header
        session._id = newSessionId
      }

      const response = await sendMessage(session, json)

      // Determine if this is an initialize response — set session header
      const isInitialize = json.method === "initialize"

      if (isInitialize || session._id) {
        res.setHeader("Mcp-Session-Id", session._id || sessionId)
      }

      // For SSE-style or JSON response, set appropriate content type
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
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(response)
      }
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" })
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: err.message },
        id: null,
      }))
    }
  })
})

server.listen(PORT, () => {
  console.log(`github-mcp-server http-wrapper listening on port ${PORT}`)
})
