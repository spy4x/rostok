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

export interface VersioningConfig {
  type: string
  params?: Record<string, string>
}

export interface FolderRef {
  id: string
  path: string
  type?: string
  paused?: boolean
  devices?: string[]
  versioning?: VersioningConfig
  rescanIntervalS?: number
  fsWatcherEnabled?: boolean
  fsWatcherDelayS?: boolean
  ignorePerms?: boolean
  ignoreDelete?: boolean
}

export interface Device {
  id: string
  name?: string
  addresses?: string[]
  untrusted?: boolean
  compression?: string
  paused?: boolean
  introducer?: boolean
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
      if (f.versioning !== undefined) {
        if (
          typeof f.versioning !== "object" || f.versioning === null ||
          typeof f.versioning.type !== "string"
        ) {
          errors.push(`folders[${i}].versioning.type is required when versioning is set`)
        }
      }
      if (f.rescanIntervalS !== undefined && typeof f.rescanIntervalS !== "number") {
        errors.push(`folders[${i}].rescanIntervalS must be a number`)
      }
      if (f.paused !== undefined && typeof f.paused !== "boolean") {
        errors.push(`folders[${i}].paused must be a boolean`)
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
      if (d.addresses !== undefined) {
        if (!Array.isArray(d.addresses)) {
          errors.push(`devices[${i}].addresses must be a list`)
        } else if (!d.addresses.every((a) => typeof a === "string")) {
          errors.push(`devices[${i}].addresses must all be strings`)
        }
      }
      if (d.untrusted !== undefined && typeof d.untrusted !== "boolean") {
        errors.push(`devices[${i}].untrusted must be a boolean`)
      }
      if (d.paused !== undefined && typeof d.paused !== "boolean") {
        errors.push(`devices[${i}].paused must be a boolean`)
      }
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

/**
 * Remote user owning the host paths Syncthing needs. Throws when
 * `SSH_USER` is not set — no hardcoded fallback user, so a server
 * missing it fails loudly instead of silently creating paths owned by
 * someone else's account. Exported for tests.
 */
export function getUser(): string {
  const user = Deno.env.get("SSH_USER")
  if (!user) {
    throw new Error(
      "SSH_USER is not set — before.deploy.ts needs a remote user to own the host paths " +
        "it creates for Syncthing.",
    )
  }
  return user
}

/**
 * `[user@]host` — no brackets: ssh gets host and -p <port> as separate
 * argv slots.
 */
function targetHost(): string {
  const host = Deno.env.get("SSH_HOST")!
  const user = Deno.env.get("SSH_USER")
  return user ? `${user}@${host}` : host
}

/** Digits only, 1-65535 — the same range cli/server-keys.ts's parseSshAddress enforces. */
function isValidPort(port: string): boolean {
  if (!/^\d+$/.test(port)) return false
  const n = Number(port)
  return n >= 1 && n <= 65535
}

/**
 * The ssh options every remote call here gets: `-p <SSH_PORT>` only when
 * SSH_PORT is set (SSH_ADDRESS carried an explicit port — never a
 * default, see cli/deploy/hooks.ts's module comment), then `-o
 * ConnectTimeout=10`, `-o BatchMode=yes`. Throws if SSH_PORT is set but
 * not a valid 1-65535 port — defense in depth even though SSH_ADDRESS
 * was already validated once before deploy ever set SSH_PORT. Exported
 * for tests.
 */
export function sshOptionArgs(): string[] {
  const port = Deno.env.get("SSH_PORT")
  if (port !== undefined && !isValidPort(port)) {
    throw new Error(`invalid SSH_PORT "${port}": expected digits 1-65535`)
  }
  return [
    ...(port !== undefined ? ["-p", port] : []),
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
  ]
}

/**
 * Run a command on the remote host (or locally if SSH_HOST is unset —
 * used by this hook's own tests), passing arguments via argv. NEVER
 * compose a shell command string from user-controlled paths — that
 * allows command injection if a path contains spaces, quotes, or
 * backticks.
 *
 * Each shell op is a separate command. We chain them via `&&` inside the
 * shell, but the path/user args are passed as positional parameters so
 * they are not interpreted by the shell.
 */
export async function runRemote(
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const host = Deno.env.get("SSH_HOST")
  const cmd0 = argv[0]
  const cmdArgs = argv.slice(1)
  const proc = host
    ? new Deno.Command("ssh", {
      args: [...sshOptionArgs(), "--", targetHost(), cmd0, ...cmdArgs],
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
 * `args` are passed as bash positional parameters $1..$N (in order).
 * `$0` is always `bash` — don't prefix args with `--`.
 *
 * `-T` (disable pty allocation — this call streams a script over stdin,
 * never an interactive session) is ssh's OWN option, so it goes before
 * ssh's `--`, not after the target: once ssh sees `--`, everything past
 * it is the remote command, and `-T` there would be sent to the remote
 * shell as the literal first word of the command instead of read as an
 * ssh flag — the fix (this hook used to place it after the target).
 */
export function buildRunRemoteScriptArgs(bashArgs: string[]): string[] {
  return ["-T", ...sshOptionArgs(), "--", targetHost(), "bash", "-s", ...bashArgs]
}

async function runRemoteScript(
  script: string,
  args: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const host = Deno.env.get("SSH_HOST")
  const proc = host
    ? new Deno.Command("ssh", {
      args: buildRunRemoteScriptArgs(args),
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

/** mkdir + chown + verify. Fails the deploy on any error. */
async function ensureHostDir(path: string, user: string): Promise<void> {
  // Single-quoted arg: prevents shell expansion of $, `, etc. even if the
  // remote shell is sh/bash without special handling. The single quotes
  // are literal shell syntax, not part of argv — only the contents
  // between them reach mkdir/chown/test as $1.
  const mkdir = await runRemote(["mkdir", "-p", "--", path])
  if (mkdir.code !== 0) {
    throw new Error(`mkdir -p "${path}" failed: ${mkdir.stderr.trim()}`)
  }
  // chown best-effort: some filesystems (vfat, ntfs, network mounts)
  // don't support ownership changes. Don't block the deploy; warn and
  // continue. The container's PUID/PGID env vars handle mismatches at
  // runtime.
  const chown = await runRemote(["chown", "--", `${user}:${user}`, path])
  if (chown.code !== 0) {
    console.warn(
      `WARN: chown ${user}:${user} "${path}" failed: ${chown.stderr.trim()} — proceeding`,
    )
  }
  // Verify the path now exists and is a directory
  // Use a streamed script so $1 isn't mangled by ssh/zsh argv joining.
  const verify = await runRemoteScript(
    `test -d "$1" && echo OK\n`,
    [path],
  )
  if (verify.stdout.trim() !== "OK") {
    throw new Error(`"${path}" is not a directory after mkdir`)
  }
}

// ── Entry point ───────────────────────────────────────────────────────

/**
 * Refuse to deploy with a missing or placeholder SYNCTHING_API_KEY.
 *
 * This runs BEFORE `docker compose up`, which is the point. Syncthing takes
 * STGUIAPIKEY literally — it does not recognise a placeholder and generate its
 * own — so starting the container with the placeholder would publish a
 * Syncthing whose API key is a value committed to this repo, on a GUI that
 * Traefik exposes publicly. Catching it in after.deploy would be too late:
 * the container would already be running and reachable.
 */
export function assertUsableApiKey(): void {
  const key = Deno.env.get("SYNCTHING_API_KEY") ?? ""
  if (!key) {
    throw new Error(
      "SYNCTHING_API_KEY is not set. Generate one with\n" +
        "  head -c 24 /dev/urandom | base64\n" +
        "then add it to this server's .env, run `deno task env:encrypt`, and commit the .env.age.",
    )
  }
  if (key.startsWith("REPLACE_WITH_")) {
    throw new Error(
      "SYNCTHING_API_KEY is still the placeholder. Syncthing would use it verbatim as a\n" +
        "publicly-known API key on an internet-exposed GUI. Generate a real one with\n" +
        "  head -c 24 /dev/urandom | base64",
    )
  }
  if (key.length < 16) {
    throw new Error(`SYNCTHING_API_KEY is too short (${key.length} chars); use at least 16.`)
  }
}

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
  assertUsableApiKey()
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
