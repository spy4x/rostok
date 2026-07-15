// after.deploy.ts — Syncthing idempotent reconciler.
//
// Reads configs/syncthing.yml and reconciles the running Syncthing via
// REST API. For each declared folder and device:
//   - Adds missing entries (devices only — folder encrypt-passwords are
//     always preserved from the current API state, never declared in YAML)
//   - Applies any declared field overrides (path, versioning, paused,
//     addresses, untrusted, ...). Fields not declared in YAML keep their
//     current value (incremental changes — adding a new YAML field
//     doesn't blast away other settings).
//   - Re-reads every entry after writing to verify the desired state.
//
// Required:
//   SYNCTHING_API_KEY must be set in .env (encrypted). If it's missing
//     or still the placeholder, after.deploy exits non-zero, marking the
//     syncthing stack as failed in the deploy summary. Auto-bootstrap
//     from the container's config.xml was removed — IaC always provides
//     the key explicitly so the deploy's contract is enforceable.
//
// Deletion policy: removing a folder or device from syncthing.yml does
//   NOT remove it from the running Syncthing. Reconcile-only.
//
// API errors include response body for diagnosis. JSON parse failures are
// wrapped with endpoint + 200-byte snippet.

import { parse as parseYaml } from "yaml"
import { type FolderRef, validateConfig } from "./before.deploy.ts"

// ── API types ─────────────────────────────────────────────────────────

export interface ApiFolder {
  id: string
  label: string
  path: string
  type: string
  paused?: boolean
  versioning?: { type: string; params?: Record<string, string>; [k: string]: unknown }
  devices: { deviceID: string; encryptionPassword?: string; introducedBy?: string }[]
  [key: string]: unknown
}

export interface ApiDevice {
  deviceID: string
  name: string
  addresses?: string[]
  compression?: string
  paused?: boolean
  introducer?: boolean
  skipIntroductionRemovals?: boolean
  introducedBy?: string
  untrusted?: boolean
  [key: string]: unknown
}

// ── Pure reconciliation (exported for tests) ──────────────────────────

/** Resolve folder.devices (names) → full device IDs using the name map. */
export function resolveFolderDeviceIds(
  folder: FolderRef,
  nameMap: Map<string, string>,
): string[] {
  const out: string[] = []
  for (const name of folder.devices ?? []) {
    const id = nameMap.get(name)
    if (!id) {
      throw new Error(`Folder "${folder.id}" references unknown device "${name}"`)
    }
    out.push(id)
  }
  return out
}

/**
 * Compute desired folder state by overlaying YAML over current API state.
 * Encryption passwords are always preserved from current (secrets — never
 * declared in YAML).
 */
export function desiredFolder(
  yaml: FolderRef,
  current: ApiFolder,
  nameMap: Map<string, string>,
): ApiFolder {
  // Deep copy of current state — preserves every field we don't declare,
  // including encryptionPasswords and any future GUI-managed knobs.
  const out: ApiFolder = JSON.parse(JSON.stringify(current))

  // Declared fields override
  out.path = yaml.path
  if (yaml.type !== undefined) out.type = yaml.type
  if (yaml.paused !== undefined) out.paused = yaml.paused

  if (yaml.versioning !== undefined) {
    out.versioning = {
      ...(current.versioning ?? {}),
      type: yaml.versioning.type,
      params: yaml.versioning.params ?? {},
    }
  }

  // Devices: rebuild from declared names, preserve encryptionPasswords and
  // introducedBy (any other field syncthing tracks per device).
  const desiredIds = resolveFolderDeviceIds(yaml, nameMap)
  out.devices = desiredIds.map((deviceID) => {
    const cur = current.devices.find((d) => d.deviceID === deviceID)
    return {
      deviceID,
      encryptionPassword: cur?.encryptionPassword ?? "",
      ...(cur?.introducedBy !== undefined ? { introducedBy: cur.introducedBy } : {}),
    }
  })

  return out
}

/** Compute desired device state — overlay YAML over current. */
export function desiredDevice(
  yaml: {
    id: string
    name?: string
    addresses?: string[]
    untrusted?: boolean
    compression?: string
    paused?: boolean
    introducer?: boolean
  },
  current: ApiDevice,
): ApiDevice {
  const out: ApiDevice = JSON.parse(JSON.stringify(current))
  out.deviceID = yaml.id
  if (yaml.name !== undefined) out.name = yaml.name
  if (yaml.addresses !== undefined) out.addresses = yaml.addresses
  if (yaml.untrusted !== undefined) out.untrusted = yaml.untrusted
  if (yaml.compression !== undefined) out.compression = yaml.compression
  if (yaml.paused !== undefined) out.paused = yaml.paused
  if (yaml.introducer !== undefined) out.introducer = yaml.introducer
  return out
}

/** True iff two values differ (deep). `null` and `undefined` equal absent. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || a === null) return b === undefined || b === null
  if (b === undefined || b === null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== "object") return a === b
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const ba = b as unknown[]
    if (a.length !== ba.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], ba[i])) return false
    return true
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)])
  for (const k of keys) if (!deepEqual(ao[k], bo[k])) return false
  return true
}

// ── I/O (curl + ssh) ──────────────────────────────────────────────────

const SSH = Deno.env.get("SSH_ADDRESS") ?? ""
const API_KEY = Deno.env.get("SYNCTHING_API_KEY") ?? ""

async function runOnRemote(cmd: string): Promise<string> {
  const argv = SSH ? ["ssh", SSH, cmd] : ["bash", "-c", cmd]
  const proc = new Deno.Command(argv[0], {
    args: argv.slice(1),
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
  const cmd = `curl -sf -H 'X-API-Key: ${API_KEY}' 'http://localhost:8384${path}'`
  let out: string
  try {
    out = await runOnRemote(cmd)
  } catch (err) {
    throw new Error(`GET ${path} failed: ${(err as Error).message}`)
  }
  try {
    return JSON.parse(out) as T
  } catch {
    throw new Error(`GET ${path} returned non-JSON: ${out.slice(0, 200)}`)
  }
}

async function apiSend(method: string, path: string, body?: unknown): Promise<void> {
  // Send body via stdin to avoid any shell-escaping trouble.
  let stdinPayload: Uint8Array | undefined
  if (body !== undefined) stdinPayload = new TextEncoder().encode(JSON.stringify(body))

  const statusCmd = [
    `curl -sS -o /dev/null -w '%{http_code}'`,
    `-H 'X-API-Key: ${API_KEY}'`,
    `-X ${method}`,
    body !== undefined ? `-H 'Content-Type: application/json'` : "",
    body !== undefined ? `--data-binary @-` : "",
    `'http://localhost:8384${path}'`,
  ].filter(Boolean).join(" ")

  const argv = SSH ? ["ssh", SSH, statusCmd] : ["bash", "-c", statusCmd]
  const proc = new Deno.Command(argv[0], {
    args: argv.slice(1),
    stdin: stdinPayload ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  })
  const subprocess = proc.spawn()
  if (stdinPayload) {
    const writer = subprocess.stdin.getWriter()
    await writer.write(stdinPayload)
    await writer.close()
  }
  const out = await subprocess.output()
  const stdout = new TextDecoder().decode(out.stdout).trim()
  const stderr = new TextDecoder().decode(out.stderr).trim()

  if (code(out) !== 0 || stdout !== "200") {
    let bodySnippet = ""
    try {
      const bodyOut = await runOnRemote(
        `curl -sS -X ${method} -H 'X-API-Key: ${API_KEY}' ${
          body !== undefined ? `-H 'Content-Type: application/json' --data-binary @-` : ""
        } 'http://localhost:8384${path}'`,
      )
      bodySnippet = ` — response: ${bodyOut.trim().slice(0, 500)}`
    } catch { /* best-effort diagnostics */ }
    throw new Error(
      `${method} ${path} failed (process exit ${code(out)}, HTTP ${stdout})${
        stderr ? `: ${stderr}` : ""
      }${bodySnippet}`,
    )
  }
}

function code(out: { code: number }): number {
  return out.code
}

async function waitForApi(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      await runOnRemote(
        `curl -sf -H 'X-API-Key: ${API_KEY}' http://localhost:8384/rest/system/status > /dev/null`,
      )
      return
    } catch {
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  throw new Error("Syncthing API did not respond within 60s")
}

// ── Entry point ───────────────────────────────────────────────────────

async function main() {
  // Loud, no-hidden-errors gate: SYNCTHING_API_KEY is mandatory.
  if (!API_KEY) {
    throw new Error(
      "SYNCTHING_API_KEY is not set. Add it to this server's .env (encrypt, then commit the .env.age).",
    )
  }
  if (API_KEY.startsWith("REPLACE_WITH_")) {
    throw new Error(
      `SYNCTHING_API_KEY is still the placeholder ("${
        API_KEY.slice(0, 40)
      }…"). Generate a real key and update .env.`,
    )
  }

  let text: string
  try {
    text = await Deno.readTextFile("configs/syncthing.yml")
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log("configs/syncthing.yml not found — skipping syncthing after-deploy")
      Deno.exit(0)
    }
    throw err
  }
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (err) {
    throw new Error(`configs/syncthing.yml is not valid YAML: ${(err as Error).message}`)
  }
  const config = validateConfig(parsed)

  console.log("Waiting for Syncthing API…")
  await waitForApi()

  const status = await apiGet<{ myID: string }>("/rest/system/status")
  const myId = status.myID
  console.log(`Local device: ${myId.slice(0, 7)}…`)

  const currentFolders = await apiGet<ApiFolder[]>("/rest/config/folders")
  const currentDevices = await apiGet<ApiDevice[]>("/rest/config/devices")

  const nameMap = new Map<string, string>()
  for (const d of config.devices ?? []) {
    if (typeof d?.name === "string" && typeof d?.id === "string") {
      nameMap.set(d.name, d.id)
    }
  }

  // ── Devices: add missing, then overlay desired state for existing ──
  console.log("\nDevices:")
  const foldersById = new Map(currentFolders.map((f) => [f.id, f]))
  const devicesById = new Map(currentDevices.map((d) => [d.deviceID, d]))

  for (const dev of config.devices ?? []) {
    const existing = devicesById.get(dev.id)
    if (!existing) {
      console.log(`  + add ${dev.name ?? dev.id.slice(0, 7)} (${dev.id.slice(0, 7)}…)`)
      await apiSend("POST", "/rest/config/devices", {
        deviceID: dev.id,
        name: dev.name ?? dev.id.slice(0, 7),
        addresses: dev.addresses ?? ["dynamic"],
        compression: dev.compression ?? "metadata",
        ...(dev.untrusted !== undefined ? { untrusted: dev.untrusted } : {}),
        ...(dev.paused !== undefined ? { paused: dev.paused } : {}),
        ...(dev.introducer !== undefined ? { introducer: dev.introducer } : {}),
      })
      continue
    }
    const desired = desiredDevice(dev, existing)
    if (deepEqual(existing, desired)) {
      console.log(`  ✓ ${dev.name ?? dev.id.slice(0, 7)}`)
      continue
    }
    console.log(`  ~ update ${dev.name ?? dev.id.slice(0, 7)}`)
    await apiSend("PUT", `/rest/config/devices/${encodeURIComponent(dev.id)}`, desired)
  }

  // ── Folders: add missing, then overlay desired state for existing ──
  console.log("\nFolders:")
  for (const folder of config.folders ?? []) {
    const existing = foldersById.get(folder.id)
    if (!existing) {
      console.log(`  + add ${folder.id} → ${folder.path}`)
      await apiSend("POST", "/rest/config/folders", {
        id: folder.id,
        label: folder.id,
        path: folder.path,
        type: folder.type ?? "sendreceive",
        paused: folder.paused,
        versioning: folder.versioning
          ? {
            type: folder.versioning.type,
            params: folder.versioning.params ?? {},
          }
          : undefined,
        devices: resolveFolderDeviceIds(folder, nameMap).map((deviceID) => ({
          deviceID,
          encryptionPassword: "",
        })),
      })
      continue
    }
    const desired = desiredFolder(folder, existing, nameMap)
    if (deepEqual(existing, desired)) {
      console.log(`  ✓ ${folder.id}`)
      continue
    }
    const diffs: string[] = []
    if (!deepEqual(existing.path, desired.path)) diffs.push(`path`)
    if (!deepEqual(existing.versioning, desired.versioning)) diffs.push(`versioning`)
    if (!deepEqual(existing.devices, desired.devices)) diffs.push(`devices`)
    if (!deepEqual(existing.paused, desired.paused)) diffs.push(`paused`)
    console.log(`  ~ update ${folder.id} (${diffs.join(", ") || "minor fields"})`)
    await apiSend("PUT", `/rest/config/folders/${encodeURIComponent(folder.id)}`, desired)
  }

  // ── Re-read and verify desired state ───────────────────────────────
  console.log("\nVerifying desired state…")
  const finalDevices = await apiGet<ApiDevice[]>("/rest/config/devices")
  const finalFolders = await apiGet<ApiFolder[]>("/rest/config/folders")
  const finalDevicesById = new Map(finalDevices.map((d) => [d.deviceID, d]))
  const finalFoldersById = new Map(finalFolders.map((f) => [f.id, f]))

  const errors: string[] = []
  for (const dev of config.devices ?? []) {
    const found = finalDevicesById.get(dev.id)
    if (!found) {
      errors.push(`device missing after write: ${dev.name ?? dev.id}`)
      continue
    }
    const desired = desiredDevice(dev, found)
    if (!deepEqual(found, desired)) {
      errors.push(`device drift after write: ${dev.name ?? dev.id}`)
    }
  }
  for (const folder of config.folders ?? []) {
    const found = finalFoldersById.get(folder.id)
    if (!found) {
      errors.push(`folder missing after write: ${folder.id}`)
      continue
    }
    const desired = desiredFolder(folder, found, nameMap)
    if (!deepEqual(found, desired)) {
      errors.push(`folder drift after write: ${folder.id}`)
    }
  }
  if (errors.length > 0) {
    throw new Error(`Syncthing verification failed:\n  - ${errors.join("\n  - ")}`)
  }
  console.log("✓ verified")
  console.log("\n✓ Syncthing config reconciled")
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("after.deploy.ts FAILED:", err instanceof Error ? err.message : String(err))
    Deno.exit(1) // marker for the deploy script — syncthing deploy fails
  })
}
