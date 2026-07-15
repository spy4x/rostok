// before.deploy.ts — ensures Syncthing host paths exist before compose up.
//
// Reads configs/syncthing.yml and creates:
//   - data_dir (e.g. ~/ssd-2tb/apps/.volumes/syncthing)
//   - each mount root (e.g. ~/ssd-2tb/sync, ~/hdd-4tb)
//   - each folder subdirectory (e.g. ~/ssd-2tb/sync/archive,
//     ~/hdd-4tb/sync/backups). Resolved by joining folder.path (container
//     side) to the longest matching mount's host prefix.
//
// Verifies every created directory exists after each command. Fails the
// deploy on any mkdir / chown error so storage issues surface immediately
// instead of showing up as "container unhealthy" later.
//
// Skips silently if configs/syncthing.yml is missing (server doesn't run
// Syncthing).

import { parse as parseYaml } from "yaml"

// ── Pure helpers (exported for unit tests) ────────────────────────────

export interface Mount {
  host: string
  container: string
}

export interface FolderRef {
  id: string
  path: string
  type?: string
  devices?: string[]
}

export interface Device {
  id: string
  name?: string
}

export interface SyncthingConfig {
  data_dir: string
  mounts?: Mount[]
  folders?: FolderRef[]
  devices?: Device[]
}

export class ConfigError extends Error {
  constructor(message: string, public readonly errors: string[]) {
    super(message)
  }
}

/**
 * Validate the parsed YAML and return a normalized config.
 * Throws ConfigError listing every problem found (not just the first),
 * so the operator can fix them all at once.
 */
export function validateConfig(raw: unknown): SyncthingConfig {
  const errors: string[] = []
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigError("syncthing.yml must be a YAML mapping", ["root is not an object"])
  }
  const cfg = raw as Partial<SyncthingConfig>

  if (typeof cfg.data_dir !== "string" || !cfg.data_dir.trim()) {
    errors.push("`data_dir` is required and must be a non-empty string")
  }

  const mounts = Array.isArray(cfg.mounts) ? cfg.mounts : []
  if (Array.isArray(cfg.mounts)) {
    for (const [i, m] of mounts.entries()) {
      if (typeof m?.host !== "string" || typeof m?.container !== "string") {
        errors.push(`mounts[${i}]: both host and container must be strings`)
      } else if (!m.container.startsWith("/")) {
        errors.push(`mounts[${i}].container must be an absolute path (got "${m.container}")`)
      }
    }
  }

  const folders = Array.isArray(cfg.folders) ? cfg.folders : []
  if (Array.isArray(cfg.folders)) {
    const seenIds = new Set<string>()
    for (const [i, f] of folders.entries()) {
      if (typeof f?.id !== "string" || !f.id.trim()) {
        errors.push(`folders[${i}].id is required`)
        continue
      }
      if (seenIds.has(f.id)) {
        errors.push(`folders[${i}].id "${f.id}" is duplicated`)
      }
      seenIds.add(f.id)
      if (typeof f.path !== "string" || !f.path.startsWith("/")) {
        errors.push(`folders[${i}].path must be an absolute path (got "${f.path}")`)
      }
      if (!Array.isArray(f.devices)) {
        errors.push(`folders[${i}].devices must be a list`)
      }
    }
  }

  const devices = Array.isArray(cfg.devices) ? cfg.devices : []
  if (Array.isArray(cfg.devices)) {
    const seenIds = new Set<string>()
    const seenNames = new Set<string>()
    for (const [i, d] of devices.entries()) {
      if (typeof d?.id !== "string" || !d.id.trim()) {
        errors.push(`devices[${i}].id is required`)
      } else if (seenIds.has(d.id)) {
        errors.push(`devices[${i}].id "${d.id}" is duplicated`)
      }
      if (typeof d?.name !== "string" || !d.name.trim()) {
        errors.push(`devices[${i}].name is required`)
      } else if (seenNames.has(d.name)) {
        errors.push(`devices[${i}].name "${d.name}" is duplicated`)
      }
      seenIds.add(typeof d?.id === "string" ? d.id : "")
      seenNames.add(typeof d?.name === "string" ? d.name : "")
    }
  }

  // Folder devices must reference declared devices (by name)
  const deviceNames = new Set(
    devices.map((d) => (typeof d?.name === "string" ? d.name : "")).filter(Boolean),
  )
  for (const [i, f] of folders.entries()) {
    if (!Array.isArray(f?.devices)) continue
    for (const name of f.devices) {
      if (typeof name !== "string") {
        errors.push(`folders[${i}].devices contains a non-string entry`)
        continue
      }
      if (!deviceNames.has(name)) {
        errors.push(
          `folders[${i}] ("${f.id}") references device "${name}" which is not declared in devices[]`,
        )
      }
    }
  }

  if (errors.length > 0) {
    const summary = `Invalid configs/syncthing.yml (${errors.length} error${
      errors.length === 1 ? "" : "s"
    }):\n  - ${errors.join("\n  - ")}`
    throw new ConfigError(summary, errors)
  }

  return cfg as SyncthingConfig
}

export function expandHome(p: string, user: string): string {
  if (p.startsWith("~/")) return `/home/${user}${p.slice(1)}`
  return p
}

/**
 * Resolve a container-side folder path to the corresponding host path by
 * stripping the longest-matching mount.container prefix and joining onto
 * mount.host (already home-expanded).
 *
 * Throws if no mount matches — the operator forgot to declare the root.
 */
export function resolveFolderHostPath(
  containerPath: string,
  mounts: ReadonlyArray<{ host: string; container: string }>,
  user: string,
): string {
  // Find the longest matching container prefix
  const matches = mounts
    .filter((m) => containerPath === m.container || containerPath.startsWith(m.container + "/"))
    .sort((a, b) => b.container.length - a.container.length)

  if (matches.length === 0) {
    throw new Error(
      `Folder path "${containerPath}" is not under any declared mount (${
        mounts.map((m) => m.container).join(", ")
      })`,
    )
  }
  const mount = matches[0]
  const hostBase = expandHome(mount.host, user)
  const sub = containerPath.slice(mount.container.length).replace(/^\//, "")
  return sub ? `${hostBase}/${sub}` : hostBase
}

/** All host paths that need to exist for Syncthing to start cleanly. */
export function collectHostPaths(
  config: SyncthingConfig,
  user: string,
): string[] {
  const out = new Set<string>()
  out.add(expandHome(config.data_dir, user))
  for (const m of config.mounts ?? []) {
    out.add(expandHome(m.host, user))
  }
  for (const f of config.folders ?? []) {
    out.add(resolveFolderHostPath(f.path, config.mounts ?? [], user))
  }
  return [...out].sort()
}

// ── Shell helpers (tested via integration) ────────────────────────────

function getUser(): string {
  return Deno.env.get("HOMELAB_USER") ?? "spy4x"
}

async function runOnRemote(cmd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const ssh = Deno.env.get("SSH_ADDRESS")
  const argv = ssh ? ["ssh", ssh, cmd] : ["bash", "-c", cmd]
  const proc = new Deno.Command(argv[0], {
    args: argv.slice(1),
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

/** mkdir + chown + verify. Fails the deploy on any error. */
async function ensureHostDir(path: string, user: string): Promise<void> {
  const mkdir = await runOnRemote(`mkdir -p "${path}"`)
  if (mkdir.code !== 0) {
    throw new Error(`mkdir -p "${path}" failed: ${mkdir.stderr.trim()}`)
  }
  // chown best-effort: some filesystems (vfat, ntfs, network mounts)
  // don't support ownership changes. Don't block the deploy; warn and
  // continue. The container's PUID/PGID env vars handle mismatches at
  // runtime.
  const chown = await runOnRemote(`chown ${user}:${user} "${path}"`)
  if (chown.code !== 0) {
    console.warn(
      `WARN: chown ${user}:${user} "${path}" failed: ${chown.stderr.trim()} — proceeding`,
    )
  }
  // Verify the path now exists and is a directory
  const verify = await runOnRemote(`test -d "${path}" && echo OK`)
  if (verify.stdout.trim() !== "OK") {
    throw new Error(`"${path}" is not a directory after mkdir`)
  }
}

// ── Entry point ───────────────────────────────────────────────────────

async function main() {
  let text: string
  try {
    text = await Deno.readTextFile("configs/syncthing.yml")
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log("configs/syncthing.yml not found — skipping syncthing before-deploy")
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
  const user = getUser()
  const paths = collectHostPaths(config, user)
  console.log(`Ensuring ${paths.length} host path(s) for Syncthing…`)
  for (const p of paths) {
    await ensureHostDir(p, user)
    console.log(`✓ ${p}`)
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (err) {
    console.error("before.deploy.ts FAILED:", err instanceof Error ? err.message : String(err))
    Deno.exit(1)
  }
}
