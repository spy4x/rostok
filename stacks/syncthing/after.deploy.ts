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

// ── I/O (curl + ssh, via docker exec) ────────────────────────────────

const API_KEY = Deno.env.get("SYNCTHING_API_KEY") ?? ""
const CONTAINER = "hl-syncthing"

/**
 * Run a command on the remote host (or locally if SSH_ADDRESS is unset),
 * passing arguments via argv. NEVER compose a shell command string from
 * user-controlled paths.
 *
 * `argv[0]` is the program name; the rest are its arguments. We never
 * embed `argv` itself as the args list — that would double-include the
 * program name and confuse CLIs like docker exec (which treats leading
 * flags from a doubled argv as its own flags).
 */
async function runRemote(
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const ssh = Deno.env.get("SSH_ADDRESS")
  const cmd0 = argv[0]
  const cmdArgs = argv.slice(1)
  const proc = ssh
    ? new Deno.Command("ssh", {
      args: [ssh, "--", cmd0, ...cmdArgs],
      stdout: "piped",
      stderr: "piped",
    })
    : new Deno.Command(cmd0, {
      args: cmdArgs,
      stdout: "piped",
      stderr: "piped",
    })
  const out = await proc.output()
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  }
}

/**
 * Run a shell script on the remote host via `bash -s`, streaming the
 * script via stdin. Use this when the script body has special characters
 * (quotes, $, |, >) that get mangled by ssh's argv-to-string conversion
 * on shells like zsh with strict glob handling.
 *
 * `args` are passed as bash positional parameters. With `bash -s` (no
 * `--`), bash uses `$0=bash` and `$1..$N` map to the first..N args in
 * order. (Don't pass `--` — it makes args[0] become $0.)
 *
 * Currently unused (kept for future script-needing use cases like
 * `mkdir` chains or multi-step shell work).
 */
// deno-lint-ignore no-unused-vars
async function runRemoteScript(
  script: string,
  args: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const ssh = Deno.env.get("SSH_ADDRESS")
  const proc = ssh
    ? new Deno.Command("ssh", {
      args: [ssh, "-T", "bash", "-s", ...args],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    })
    : new Deno.Command("bash", {
      args: ["-s", ...args],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    })
  const sub = proc.spawn()
  const writer = sub.stdin.getWriter()
  await writer.write(new TextEncoder().encode(script))
  await writer.close()
  const out = await sub.output()
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  }
}

/**
 * Call the Syncthing REST API from inside the syncthing container.
 *
 * We use `docker exec ... curl ... http://localhost:8384/...` instead of
 * curl from the host because the container's 8384 port is NOT published
 * to the host — relying on host port mapping would break the deploy flow.
 * Inside the container, syncthing itself listens on 127.0.0.1:8384, so
 * `localhost:8384` from inside the container always works.
 *
 * Args are passed positionally. Use dockerExecStdin() when you need to
 * pipe data in.
 */
async function dockerExec(
  cmd: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runRemote(["docker", "exec", CONTAINER, ...cmd])
}

/**
 * Run `docker exec <container> <cmd>` with stdin piped from the host.
 * Required for body-bearing curl calls because tempfiles written to the
 * host's /tmp aren't visible inside the container.
 */
async function dockerExecStdin(
  cmd: readonly string[],
  stdinPayload: Uint8Array,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const ssh = Deno.env.get("SSH_ADDRESS")
  // `docker exec -i <container> <cmd>` runs the cmd with the host's
  // stdin piped in. We then run `curl ... --data-binary @-` to read it.
  const proc = ssh
    ? new Deno.Command("ssh", {
      // ssh is the program name; sshPrefix excludes it (avoid double-pass).
      args: [ssh, "--", "docker", "exec", "-i", CONTAINER, ...cmd],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    })
    : new Deno.Command("docker", {
      args: ["exec", "-i", CONTAINER, ...cmd],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    })
  const sub = proc.spawn()
  const writer = sub.stdin.getWriter()
  await writer.write(stdinPayload)
  await writer.close()
  const out = await sub.output()
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  }
}

/** Safe JSON parser with endpoint context. Throws on invalid shape. */
function parseApiJson<T>(path: string, raw: string, validator: (v: unknown) => v is T): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`GET ${path} returned non-JSON: ${raw.slice(0, 200)}`)
  }
  if (!validator(parsed)) {
    throw new Error(
      `GET ${path} returned unexpected shape: ${JSON.stringify(parsed).slice(0, 200)}`,
    )
  }
  return parsed
}

export const isSystemStatus = (v: unknown): v is { myID: string } => {
  if (typeof v !== "object" || v === null) return false
  const myID = (v as Record<string, unknown>).myID
  return typeof myID === "string" && myID.length > 0 && myID.includes("-")
}

export const isFolderArray = (v: unknown): v is ApiFolder[] =>
  Array.isArray(v) && v.every((f) =>
    typeof f === "object" && f !== null &&
    typeof (f as { id?: unknown }).id === "string" &&
    typeof (f as { path?: unknown }).path === "string" &&
    Array.isArray((f as { devices?: unknown }).devices)
  )

export const isDeviceArray = (v: unknown): v is ApiDevice[] =>
  Array.isArray(v) && v.every((d) =>
    typeof d === "object" && d !== null &&
    typeof (d as { deviceID?: unknown }).deviceID === "string" &&
    typeof (d as { name?: unknown }).name === "string"
  )

async function apiGet<T>(path: string, validator: (v: unknown) => v is T): Promise<T> {
  const res = await dockerExec([
    "curl",
    "-fsS",
    "-H",
    "X-API-Key:" + API_KEY,
    `http://localhost:8384${path}`,
  ])
  if (res.code !== 0) {
    throw new Error(`GET ${path} failed (exit ${res.code}): ${res.stderr.trim()}`)
  }
  return parseApiJson(path, res.stdout, validator)
}

async function apiSend(method: string, path: string, body?: unknown): Promise<void> {
  // We use curl inside the syncthing container (BusyBox wget only does
  // GET/POST — no PUT/DELETE method support). curl is the safer tool.
  if (body === undefined) {
    const res = await dockerExec([
      "curl",
      "-fsS",
      "-o",
      "/dev/null",
      "-X",
      method,
      "-H",
      "X-API-Key:" + API_KEY,
      `http://localhost:8384${path}`,
    ])
    if (res.code !== 0) {
      throw new Error(
        `${method} ${path} failed (exit ${res.code}): ${res.stderr.trim()}`,
      )
    }
    return
  }

  // Body-bearing request: pipe via stdin. The container sees `curl`'s
  // stdin directly (via `docker exec -i`), so `--data-binary @-` reads
  // the body bytes from our stdin pipe. Avoids tempfile-based writes
  // (which can't be visible inside the container from the host's /tmp).
  const payload = new TextEncoder().encode(JSON.stringify(body))
  const res = await dockerExecStdin([
    "curl",
    "-fsS",
    "-o",
    "/dev/null",
    "-X",
    method,
    "-H",
    "X-API-Key:" + API_KEY,
    "-H",
    "Content-Type:application/json",
    "--data-binary",
    "@-",
    `http://localhost:8384${path}`,
  ], payload)
  if (res.code !== 0) {
    throw new Error(
      `${method} ${path} failed (exit ${res.code}): ${res.stderr.trim()}`,
    )
  }
}

async function waitForApi(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      await dockerExec([
        "curl",
        "-fsS",
        "-o",
        "/dev/null",
        "-H",
        "X-API-Key:" + API_KEY,
        "http://localhost:8384/rest/system/status",
      ])
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

  const status = await apiGet<{ myID: string }>("/rest/system/status", isSystemStatus)
  const myId = status.myID
  console.log(`Local device: ${myId.slice(0, 7)}…`)

  const currentFolders = await apiGet<ApiFolder[]>("/rest/config/folders", isFolderArray)
  const currentDevices = await apiGet<ApiDevice[]>("/rest/config/devices", isDeviceArray)

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
  const finalDevices = await apiGet<ApiDevice[]>("/rest/config/devices", isDeviceArray)
  const finalFolders = await apiGet<ApiFolder[]>("/rest/config/folders", isFolderArray)
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
