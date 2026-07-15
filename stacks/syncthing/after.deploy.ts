// after.deploy.ts — Syncthing idempotent reconciler.
//
// Reads servers/<server>/syncthing.yml and ensures the running Syncthing
// instance matches via REST API:
//   - Adds missing devices (preserving any existing encryption passwords)
//   - Renames devices whose name differs
//   - Adds missing folders with the declared devices
//   - Updates folders whose path or device list changed (preserves passwords)
//
// Skips silently if servers/<server>/syncthing.yml is missing.
// Requires SYNCTHING_API_KEY env var (set via STGUIAPIKEY in compose).

import { parse as parseYaml } from "yaml"

interface Folder {
  id: string
  path: string
  type?: string
  devices: string[]
}

interface Device {
  id: string
  name?: string
}

interface SyncthingConfig {
  data_dir: string
  mounts?: { host: string; container: string }[]
  folders?: Folder[]
  devices?: Device[]
}

interface ApiFolder {
  id: string
  label: string
  path: string
  type: string
  devices: { deviceID: string; encryptionPassword?: string }[]
  [key: string]: unknown
}

interface ApiDevice {
  deviceID: string
  name: string
  [key: string]: unknown
}

const SSH = Deno.env.get("SSH_ADDRESS") ?? ""
const SERVER = Deno.env.get("DEPLOY_AS") ?? Deno.env.get("SERVER_NAME") ?? ""
const API_KEY = Deno.env.get("SYNCTHING_API_KEY") ?? ""

if (!SERVER) {
  console.error("after.deploy.ts: DEPLOY_AS / SERVER_NAME not set")
  Deno.exit(1)
}

// Config path: prefer `configs/syncthing.yml` (deploy tempDir layout).
// Fall back to `servers/<server>/configs/syncthing.yml` for local dev.
const configPaths = [
  "configs/syncthing.yml",
  `servers/${SERVER}/configs/syncthing.yml`,
]

let configPath: string | null = null
for (const p of configPaths) {
  try {
    await Deno.stat(p)
    configPath = p
    break
  } catch {
    // try next
  }
}

if (!configPath) {
  console.log(`No syncthing.yml found in ${configPaths.join(", ")} — skipping`)
  Deno.exit(0)
}

const text = await Deno.readTextFile(configPath)
const config = parseYaml(text) as SyncthingConfig
console.log(`Loaded ${configPath}`)

if (!API_KEY) {
  console.error(
    `after.deploy.ts: SYNCTHING_API_KEY not set in ${SERVER} .env`,
  )
  console.error(`Capture from existing config.xml: <apikey>...</apikey>`)
  Deno.exit(1)
}

async function ssh(cmd: string): Promise<string> {
  if (!SSH) {
    // Local deploy — run directly. Useful for testing on the same host.
    const proc = new Deno.Command("bash", {
      args: ["-c", cmd],
      stdout: "piped",
      stderr: "piped",
    })
    const out = await proc.output()
    if (out.code !== 0) {
      throw new Error(new TextDecoder().decode(out.stderr).trim())
    }
    return new TextDecoder().decode(out.stdout)
  }
  const proc = new Deno.Command("ssh", {
    args: [SSH, cmd],
    stdout: "piped",
    stderr: "piped",
  })
  const out = await proc.output()
  if (out.code !== 0) {
    throw new Error(new TextDecoder().decode(out.stderr).trim())
  }
  return new TextDecoder().decode(out.stdout)
}

async function apiGet<T>(path: string): Promise<T> {
  const out = await ssh(
    `curl -s -H 'X-API-Key: ${API_KEY}' 'http://localhost:8384${path}'`,
  )
  return JSON.parse(out) as T
}

async function apiSend(method: string, path: string, body?: unknown): Promise<void> {
  // PUT/POST to /rest/config/* returns 200 with empty body — we just need
  // it to succeed.
  const parts = [
    "curl -s -o /dev/null -w '%{http_code}'",
    `-H 'X-API-Key: ${API_KEY}'`,
    `-X ${method}`,
    `'http://localhost:8384${path}'`,
  ]
  if (body !== undefined) {
    parts.push(`-H 'Content-Type: application/json'`)
    parts.push(`-d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`)
  }
  const code = (await ssh(parts.join(" "))).trim()
  if (code !== "200") {
    throw new Error(`${method} ${path} returned HTTP ${code}`)
  }
}

async function waitForApi(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      await ssh(
        `curl -sf -H 'X-API-Key: ${API_KEY}' http://localhost:8384/rest/system/status > /dev/null`,
      )
      return
    } catch {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  throw new Error("Syncthing API did not respond within 60s")
}

async function main() {
  console.log("Waiting for Syncthing API...")
  await waitForApi()

  const status = await apiGet<{ myID: string }>("/rest/system/status")
  const myId = status.myID
  console.log(`Local device: ${myId.slice(0, 7)}`)

  const currentFolders = await apiGet<ApiFolder[]>("/rest/config/folders")
  const currentDevices = await apiGet<ApiDevice[]>("/rest/config/devices")

  const folderById = new Map(currentFolders.map((f) => [f.id, f]))
  const deviceById = new Map(currentDevices.map((d) => [d.deviceID, d]))

  // === Devices ===
  console.log("\nDevices:")
  for (const dev of config.devices ?? []) {
    const existing = deviceById.get(dev.id)
    if (!existing) {
      console.log(`  + add ${dev.name ?? dev.id.slice(0, 7)} (${dev.id})`)
      await apiSend("POST", "/rest/config/devices", {
        deviceID: dev.id,
        name: dev.name ?? dev.id.slice(0, 7),
        addresses: [],
        compression: "metadata",
      })
    } else if (dev.name && existing.name !== dev.name) {
      console.log(`  ~ rename ${existing.name} → ${dev.name}`)
      await apiSend("PUT", `/rest/config/devices/${encodeURIComponent(dev.id)}`, {
        ...existing,
        name: dev.name,
      })
    } else {
      console.log(`  ✓ ${existing.name}`)
    }
  }

  // === Folders ===
  console.log("\nFolders:")
  for (const folder of config.folders ?? []) {
    // Local device IS shared with too (matches running config). It's
    // auto-added by syncthing but we keep it in folder.devices for clarity.
    const desiredDevices = folder.devices
    const existing = folderById.get(folder.id)

    if (!existing) {
      console.log(`  + add ${folder.id} → ${folder.path}`)
      await apiSend("POST", "/rest/config/folders", {
        id: folder.id,
        label: folder.id,
        path: folder.path,
        type: folder.type ?? "sendreceive",
        devices: desiredDevices.map((deviceID) => ({
          deviceID,
          encryptionPassword: "",
        })),
      })
      continue
    }

    const existingDevices = new Set(existing.devices.map((d) => d.deviceID))
    const desiredSet = new Set(desiredDevices)
    const pathMatches = existing.path === folder.path
    const devicesMatch = existingDevices.size === desiredSet.size &&
      [...desiredSet].every((id) => existingDevices.has(id))

    if (pathMatches && devicesMatch) {
      console.log(`  ✓ ${folder.id}`)
      continue
    }

    // Update needed. Preserve existing encryptionPasswords.
    const updatedDevices = desiredDevices.map((deviceID) => {
      const cur = existing.devices.find((d) => d.deviceID === deviceID)
      return { deviceID, encryptionPassword: cur?.encryptionPassword ?? "" }
    })

    let detail = ""
    if (!pathMatches) detail += ` path ${existing.path}→${folder.path}`
    if (!devicesMatch) detail += ` devices changed`

    console.log(`  ~ update ${folder.id}${detail}`)
    await apiSend("PUT", `/rest/config/folders/${encodeURIComponent(folder.id)}`, {
      ...existing,
      path: folder.path,
      devices: updatedDevices,
    })
  }

  console.log("\n✓ Syncthing config reconciled")
}

try {
  await main()
} catch (err) {
  console.error("after.deploy.ts FAILED:", err instanceof Error ? err.message : String(err))
  // Non-fatal — syncthing still works with whatever's currently configured.
  Deno.exit(0)
}
