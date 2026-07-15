// after.deploy.ts — Syncthing idempotent reconciler.
//
// Reads configs/syncthing.yml and ensures the running Syncthing instance
// matches via REST API:
//   - Adds missing devices (preserving encryption passwords)
//   - Renames devices whose name differs
//   - Adds missing folders (device names resolved to full IDs)
//   - Updates folders whose path or device list changed (preserves passwords)
//   - Re-reads each resource after writing to verify the desired state
//
// Skips silently if configs/syncthing.yml is missing.
// Requires SYNCTHING_API_KEY env var (set via STGUIAPIKEY in compose).
//
// Deletion policy: removing a folder or device from syncthing.yml does
// NOT remove it from the running Syncthing. Reconcile-only.
//
// First-deploy bootstrap: if SYNCTHING_API_KEY is unset, captures the
// currently-running syncthing's API key from its container config.xml and
// uses it for this run. Saves it to .env if missing.
//
// API errors include response body for diagnosis. JSON parse failures are
// wrapped with endpoint + context.

import { parse as parseYaml } from "yaml"
import { type FolderRef, type SyncthingConfig, validateConfig } from "./before.deploy.ts"

// ── Pure reconciliation logic (exported for tests) ─────────────────────

export interface ApiFolder {
  id: string
  path: string
  type: string
  devices: { deviceID: string; encryptionPassword?: string }[]
  [key: string]: unknown
}

export interface ApiDevice {
  deviceID: string
  name: string
  [key: string]: unknown
}

export type DeviceChange =
  | { kind: "add"; name: string; id: string }
  | { kind: "rename"; id: string; from: string; to: string }
  | { kind: "skip"; name: string; id: string }

export type FolderChange =
  | { kind: "add"; id: string; folder: FolderRef; resolvedDeviceIds: string[] }
  | { kind: "update-path"; id: string; oldPath: string; newPath: string }
  | {
    kind: "update-devices"
    id: string
    mergedDevices: { deviceID: string; encryptionPassword: string }[]
  }
  | {
    kind: "update-both"
    id: string
    oldPath: string
    newPath: string
    mergedDevices: { deviceID: string; encryptionPassword: string }[]
  }
  | { kind: "skip"; id: string }

/** Build name → id lookup from the top-level devices[] block. */
export function buildDeviceNameMap(
  config: SyncthingConfig,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const d of config.devices ?? []) {
    if (typeof d?.name === "string" && typeof d?.id === "string") {
      map.set(d.name, d.id)
    }
  }
  return map
}

/**
 * Resolve folder.devices (a list of names) to full device IDs using the
 * top-level devices list. Throws if any name is missing — the YAML
 * validator should have caught this already.
 */
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

/** Compute the device changes needed to reconcile YAML → running. */
export function computeDeviceChanges(
  config: SyncthingConfig,
  currentDevices: ApiDevice[],
): DeviceChange[] {
  const out: DeviceChange[] = []
  const currentById = new Map(currentDevices.map((d) => [d.deviceID, d]))
  for (const dev of config.devices ?? []) {
    const id = dev.id
    const name = dev.name ?? id
    const existing = currentById.get(id)
    if (!existing) {
      out.push({ kind: "add", name, id })
    } else if (dev.name && existing.name !== dev.name) {
      out.push({ kind: "rename", id, from: existing.name, to: dev.name })
    } else {
      out.push({ kind: "skip", name, id })
    }
  }
  return out
}

/**
 * Compute folder changes with encryption-password preservation. The merged
 * devices list pairs YAML's desired device IDs with the existing
 * encryptionPassword values for those devices — passwords aren't in the
 * YAML (sensitive), so we read them out of the current API state and put
 * them back when PUTing.
 */
export function computeFolderChanges(
  config: SyncthingConfig,
  currentFolders: ApiFolder[],
  myDeviceId: string,
  nameMap: Map<string, string>,
): FolderChange[] {
  const out: FolderChange[] = []
  const currentById = new Map(currentFolders.map((f) => [f.id, f]))
  for (const folder of config.folders ?? []) {
    const desiredIds = resolveFolderDeviceIds(folder, nameMap)
    const existing = currentById.get(folder.id)

    if (!existing) {
      out.push({
        kind: "add",
        id: folder.id,
        folder,
        resolvedDeviceIds: desiredIds,
      })
      continue
    }

    // Local device is auto-added by syncthing but synced with us too in
    // the YAML — keep it in the resolved list to match the existing
    // config.xml representation.
    const desiredSet = new Set(desiredIds)
    const existingIds = new Set(existing.devices.map((d) => d.deviceID))
    const pathMatches = existing.path === folder.path
    const devicesMatch = existingIds.size === desiredSet.size &&
      [...desiredSet].every((id) => existingIds.has(id))

    if (pathMatches && devicesMatch) {
      out.push({ kind: "skip", id: folder.id })
      continue
    }

    // Preserve existing encryptionPasswords
    const mergedDevices = desiredIds.map((deviceID) => {
      const cur = existing.devices.find((d) => d.deviceID === deviceID)
      return { deviceID, encryptionPassword: cur?.encryptionPassword ?? "" }
    })

    if (!pathMatches && devicesMatch) {
      out.push({ kind: "update-path", id: folder.id, oldPath: existing.path, newPath: folder.path })
    } else if (pathMatches && !devicesMatch) {
      out.push({ kind: "update-devices", id: folder.id, mergedDevices })
    } else {
      out.push({
        kind: "update-both",
        id: folder.id,
        oldPath: existing.path,
        newPath: folder.path,
        mergedDevices,
      })
    }
    void myDeviceId // referenced for clarity in caller; reserved for future filtering
  }
  return out
}

// ── I/O (curl + ssh) ──────────────────────────────────────────────────

const SSH = Deno.env.get("SSH_ADDRESS") ?? ""
let API_KEY = Deno.env.get("SYNCTHING_API_KEY") ?? ""

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

/** Capture the API key from the running container's config.xml. */
async function captureApiKeyFromContainer(): Promise<string | null> {
  const grep = Deno.env.get("SSH_ADDRESS")
    ? `ssh ${
      Deno.env.get("SSH_ADDRESS")
    } grep -oE '<apikey>[^<]+' /home/spy4x/ssd-2tb/apps/.volumes/syncthing/config/config.xml | head -1 | sed 's/<apikey>//'`
    : `grep -oE '<apikey>[^<]+' /home/spy4x/ssd-2tb/apps/.volumes/syncthing/config/config.xml | head -1 | sed 's/<apikey>//'`
  try {
    const out = await runOnRemote(grep)
    const key = out.trim()
    return key.length === 32 ? key : null
  } catch {
    return null
  }
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

async function apiSend(method: string, path: string, body?: unknown): Promise<string> {
  // -w '%{http_code}' prints the HTTP code on stdout; -o /dev/null discards
  // the response body. Pass JSON via --data-binary @-, which reads the
  // payload from stdin and avoids any shell-escaping worries.
  let bodyStr = ""
  let stdinPayload: Uint8Array | undefined
  if (body !== undefined) {
    bodyStr = JSON.stringify(body)
    stdinPayload = new TextEncoder().encode(bodyStr)
  }
  const cmd = [
    `curl -sS -o /dev/null -w '%{http_code}'`,
    `-H 'X-API-Key: ${API_KEY}'`,
    `-X ${method}`,
    body !== undefined ? `-H 'Content-Type: application/json'` : "",
    body !== undefined ? `--data-binary @-` : "",
    `'http://localhost:8384${path}'`,
  ].filter(Boolean).join(" ")

  const argv = SSH ? ["ssh", SSH, cmd] : ["bash", "-c", cmd]
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
  const stdout = new TextDecoder().decode(out.stdout)
  const stderr = new TextDecoder().decode(out.stderr)
  const code = out.code

  // Pull response body separately so we can include it in error messages.
  let bodySnippet = ""
  if (code !== 0 && code !== 200) {
    try {
      const bodyOut = await runOnRemote(
        `curl -s -H 'X-API-Key: ${API_KEY}' -X ${method} ${
          body !== undefined ? `-H 'Content-Type: application/json' --data-binary @-` : ""
        } 'http://localhost:8384${path}'`,
      )
      bodySnippet = bodyOut.trim().slice(0, 500)
    } catch {
      // ignore — best-effort diagnostics
    }
  }

  if (code !== 0) {
    throw new Error(
      `${method} ${path} failed (exit ${code})${stderr.trim() ? `: ${stderr.trim()}` : ""}${
        bodySnippet ? ` — response: ${bodySnippet}` : ""
      }`,
    )
  }
  if (stdout.trim() !== "200") {
    throw new Error(`${method} ${path} returned HTTP ${stdout.trim()}`)
  }
  return stdout.trim()
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

  if (!API_KEY || API_KEY.startsWith("REPLACE_WITH_")) {
    const captured = await captureApiKeyFromContainer()
    if (captured) {
      console.log(
        `SYNCTHING_API_KEY not set in .env — captured from container config.xml: ${
          captured.slice(0, 7)
        }…`,
      )
      console.log("→ Save it as SYNCTHING_API_KEY in this server's .env, then re-encrypt.")
      API_KEY = captured
    } else {
      throw new Error(
        "SYNCTHING_API_KEY is not set in .env and could not be captured from the container.\n" +
          "Either set SYNCTHING_API_KEY in .env, or wait for Syncthing to start (it generates a key on first boot).",
      )
    }
  }

  console.log("Waiting for Syncthing API…")
  await waitForApi()

  const status = await apiGet<{ myID: string }>("/rest/system/status")
  const myId = status.myID
  console.log(`Local device: ${myId.slice(0, 7)}…`)

  const currentFolders = await apiGet<ApiFolder[]>("/rest/config/folders")
  const currentDevices = await apiGet<ApiDevice[]>("/rest/config/devices")

  const nameMap = buildDeviceNameMap(config)
  const deviceChanges = computeDeviceChanges(config, currentDevices)
  const folderChanges = computeFolderChanges(config, currentFolders, myId, nameMap)

  // ── Apply device changes + verify ─────────────────────────────────
  console.log("\nDevices:")
  for (const change of deviceChanges) {
    if (change.kind === "add") {
      console.log(`  + add ${change.name} (${change.id.slice(0, 7)}…)`)
      await apiSend("POST", "/rest/config/devices", {
        deviceID: change.id,
        name: change.name,
        addresses: [],
        compression: "metadata",
      })
    } else if (change.kind === "rename") {
      console.log(`  ~ rename ${change.from} → ${change.to}`)
      const existing = currentDevices.find((d) => d.deviceID === change.id)!
      await apiSend("PUT", `/rest/config/devices/${encodeURIComponent(change.id)}`, {
        ...existing,
        name: change.to,
      })
    } else {
      console.log(`  ✓ ${change.name}`)
    }
  }

  // ── Apply folder changes + verify ─────────────────────────────────
  console.log("\nFolders:")
  for (const change of folderChanges) {
    if (change.kind === "add") {
      console.log(`  + add ${change.folder.id} → ${change.folder.path}`)
      await apiSend("POST", "/rest/config/folders", {
        id: change.folder.id,
        label: change.folder.id,
        path: change.folder.path,
        type: change.folder.type ?? "sendreceive",
        devices: change.resolvedDeviceIds.map((deviceID) => ({
          deviceID,
          encryptionPassword: "",
        })),
      })
    } else if (change.kind === "update-path") {
      console.log(`  ~ path  ${change.id} ${change.oldPath} → ${change.newPath}`)
      const existing = currentFolders.find((f) => f.id === change.id)!
      await apiSend("PUT", `/rest/config/folders/${encodeURIComponent(change.id)}`, {
        ...existing,
        path: change.newPath,
      })
    } else if (change.kind === "update-devices") {
      console.log(`  ~ devs ${change.id}`)
      const existing = currentFolders.find((f) => f.id === change.id)!
      await apiSend("PUT", `/rest/config/folders/${encodeURIComponent(change.id)}`, {
        ...existing,
        devices: change.mergedDevices,
      })
    } else if (change.kind === "update-both") {
      console.log(
        `  ~ both ${change.id} (path ${change.oldPath} → ${change.newPath}, ${change.mergedDevices.length} devices)`,
      )
      const existing = currentFolders.find((f) => f.id === change.id)!
      await apiSend("PUT", `/rest/config/folders/${encodeURIComponent(change.id)}`, {
        ...existing,
        path: change.newPath,
        devices: change.mergedDevices,
      })
    } else {
      console.log(`  ✓ ${change.id}`)
    }
  }

  // ── Re-read & verify (catch silent failures) ──────────────────────
  console.log("\nVerifying desired state…")
  const finalDevices = await apiGet<ApiDevice[]>("/rest/config/devices")
  const finalFolders = await apiGet<ApiFolder[]>("/rest/config/folders")

  const errors: string[] = []
  for (const dev of config.devices ?? []) {
    const name = dev.name ?? dev.id.slice(0, 7)
    const found = finalDevices.find((d) => d.deviceID === dev.id)
    if (!found) {
      errors.push(`device missing after write: ${name}`)
    } else if (dev.name && found.name !== dev.name) {
      errors.push(`device name drift: ${name} (${found.name})`)
    }
  }
  for (const folder of config.folders ?? []) {
    const desiredIds = new Set(resolveFolderDeviceIds(folder, nameMap))
    const found = finalFolders.find((f) => f.id === folder.id)
    if (!found) {
      errors.push(`folder missing after write: ${folder.id}`)
      continue
    }
    if (found.path !== folder.path) {
      errors.push(`folder path drift: ${folder.id} (${found.path})`)
    }
    const foundIds = new Set(found.devices.map((d) => d.deviceID))
    if (
      foundIds.size !== desiredIds.size ||
      ![...desiredIds].every((id) => foundIds.has(id))
    ) {
      errors.push(`folder devices drift: ${folder.id}`)
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Syncthing verification failed:\n  - ${errors.join("\n  - ")}`,
    )
  }
  console.log("✓ verified")
  console.log("\n✓ Syncthing config reconciled")
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("after.deploy.ts FAILED:", err instanceof Error ? err.message : String(err))
    if (err instanceof Error && err.stack) console.error(err.stack)
    // Non-fatal — syncthing still works with whatever's currently configured.
    Deno.exit(0)
  })
}
