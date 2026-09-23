// Server creation flow.
//
// Per docs/v1-cli.md §3.1 (Phase 5 user feedback):
// - Writes to `servers/<server>/.env` (NOT `.env.root`).
// - SSH target accepts any string: ssh_config alias (`homelab`),
//   connection string (`user@host[:port]`), or just a hostname.
//   No validation beyond the server name itself (see #208). If
//   `user@host`, the user is parsed and used directly — the prompt is
//   skipped entirely, interactive or not (design §3.1 step 2).
// - The remote user is written as `SSH_USER` (#206/#209) — it replaces
//   `USER` (what the pre-1.0.4 wizard wrote) and `HOMELAB_USER` (what
//   deploy/ansible/syncthing read). An existing `.env` with either
//   legacy key gets migrated in place (env-files.ts:migrateSshUserKey).
// - Every field also accepts the env-style name that lands in `.env`
//   (SSH_ADDRESS, DOMAIN, ...) as a --var key, alongside the legacy
//   camelCase alias (sshTarget, domain, ...) for 1.x compatibility.
// - Encryption is optional. If `age` is missing, the wizard still
//   runs to completion; the user runs `rostok env encrypt` manually
//   after installing age.

import { join, relative } from "@std/path"
import { encryptEnvFiles } from "./encrypt.ts"
import {
  type EnvEntry,
  mergeEnv,
  migrateSshUserKey,
  readEnvFile,
  writeEnvFile,
} from "./env-files.ts"
import { promptValue } from "./prompts.ts"
import { tryCaptureStdout } from "./shell.ts"
import { DEFAULT_PATH_APPS, serverDirFor, validateServerName } from "./server-keys.ts"

/** Result of a server-create invocation. */
export interface ServerCreateResult {
  serverName: string
  /** Path to `servers/<name>/` (relative to cwd). */
  serverDir: string
  /** Path to `servers/<name>/.env` (relative to cwd). */
  envPath: string
  /** Parsed SSH target — `SSH_USER` (if any) plus the verbatim address. */
  parsedSsh: { user?: string; address: string }
}

export interface ServerCreateOptions {
  /**
   * Typed pre-supplied inputs from a programmatic caller (the wizard's
   * own defaults, tests). Wins over `providedVars` on key collision —
   * a --var flag shouldn't override what the caller explicitly asked for.
   */
  serverInputs?: Partial<ServerCreateInput>
  /**
   * Raw `--var KEY=VAL` overrides, keyed by either the env-style name
   * that lands in `.env` (`SSH_ADDRESS`, `DOMAIN`, ...) or the legacy
   * camelCase alias (`sshTarget`, `domain`, ...).
   */
  providedVars?: Record<string, string>
  /**
   * Skip prompts entirely; fail loudly on any missing required input
   * that has no default. Per docs/v1-cli.md §3.4 strict-default policy.
   */
  failFast?: boolean
  /** Override the project root (defaults to Deno.cwd()). */
  cwd?: string
}

/** Subset of the server-create inputs that can be pre-supplied. */
export interface ServerCreateInput {
  serverName: string
  sshTarget: string
  user: string
  domain: string
  contactEmail: string
  project: string
  dockerGroupId: string
  timezone: string
  puid: string
  pgid: string
  volumesPath: string
  pathApps: string
}

/** camelCase field ↔ env-style `.env` key, in write order (matches SERVER_KEYS). */
interface FieldDef {
  camel: keyof ServerCreateInput
  envKey: string
}

const FIELDS = {
  serverName: { camel: "serverName", envKey: "SERVER_NAME" },
  sshTarget: { camel: "sshTarget", envKey: "SSH_ADDRESS" },
  user: { camel: "user", envKey: "SSH_USER" },
  domain: { camel: "domain", envKey: "DOMAIN" },
  contactEmail: { camel: "contactEmail", envKey: "CONTACT_EMAIL" },
  project: { camel: "project", envKey: "PROJECT" },
  dockerGroupId: { camel: "dockerGroupId", envKey: "DOCKER_GROUP_ID" },
  timezone: { camel: "timezone", envKey: "TIMEZONE" },
  puid: { camel: "puid", envKey: "PUID" },
  pgid: { camel: "pgid", envKey: "PGID" },
  volumesPath: { camel: "volumesPath", envKey: "VOLUMES_PATH" },
  pathApps: { camel: "pathApps", envKey: "PATH_APPS" },
} satisfies Record<keyof ServerCreateInput, FieldDef>

/** The `--var` keys `server create` and the wizard's server step accept, env-style first. */
export const SERVER_VAR_KEYS: readonly string[] = Object.values(FIELDS).map((f) => f.envKey)

/** Legacy camelCase aliases for `SERVER_VAR_KEYS`, same order — kept for 1.x compatibility. */
export const SERVER_VAR_ALIASES: readonly string[] = Object.values(FIELDS).map((f) => f.camel)

/**
 * Run the server creation flow. Writes `servers/<name>/.env` and the
 * `configs/` subdirectory. Re-encrypts the per-server `.env.age` (no-op
 * if `age` isn't installed — see cli/encrypt.ts).
 */
export async function serverCreate(opts: ServerCreateOptions = {}): Promise<ServerCreateResult> {
  const cwd = opts.cwd ?? Deno.cwd()
  const input = await collectInput(opts.serverInputs, opts.providedVars, opts.failFast)

  // Parse SSH target once. `user@host[:port]` → user hint; alias is preserved.
  const parsed = parseSshTarget(input.sshTarget)

  // #208: validate before touching the filesystem — a traversal name
  // (`../x`) or anything outside SERVER_NAME_PATTERN throws here, before
  // any directory gets created.
  const serverDir = serverDirFor(cwd, input.serverName)
  const envPath = join(serverDir, ".env")

  // Read existing first to preserve unknown keys (e.g. PATH_* the user
  // added by hand) and to migrate a legacy remote-user key (#206).
  const existingRaw = await readEnvFile(envPath)
  const { entries: existing, renamedFrom } = migrateSshUserKey(existingRaw)
  if (renamedFrom) {
    console.log(`rostok: renamed ${renamedFrom} to SSH_USER in ${relative(cwd, envPath)}`)
  }

  await Deno.mkdir(join(serverDir, "configs"), { recursive: true })

  // #206: write every key scripts/deploy/+main.ts needs (DEPLOY_REQUIRED_KEYS
  // is a subset of this list) — SSH_USER always has a value (either parsed
  // from `user@host` or asked), PATH_APPS defaults to DEFAULT_PATH_APPS.
  const incoming: EnvEntry[] = [
    { key: "PROJECT", value: input.project },
    { key: "SSH_ADDRESS", value: input.sshTarget },
    { key: "SSH_USER", value: input.user },
    { key: "DOMAIN", value: input.domain },
    { key: "CONTACT_EMAIL", value: input.contactEmail },
    { key: "DOCKER_GROUP_ID", value: input.dockerGroupId },
    { key: "TIMEZONE", value: input.timezone },
    { key: "PUID", value: input.puid },
    { key: "PGID", value: input.pgid },
    { key: "VOLUMES_PATH", value: input.volumesPath },
    { key: "PATH_APPS", value: input.pathApps },
  ]
  const merged = mergeEnv(existing, incoming)
  await writeEnvFile(envPath, merged)

  // Re-encrypt (non-fatal — see cli/encrypt.ts).
  await encryptEnvFiles(cwd)

  return {
    serverName: input.serverName,
    serverDir,
    envPath,
    parsedSsh: parsed,
  }
}

/**
 * Split `user@host[:port]` into (user, address). If no `@`, returns
 * `{}` for the user — caller prompts separately.
 */
function parseSshTarget(target: string): { user?: string; address: string } {
  const at = target.lastIndexOf("@")
  if (at <= 0) return { address: target }
  return {
    user: target.slice(0, at),
    address: target.slice(at + 1),
  }
}

/** Look up a pre-supplied value: typed `serverInputs` wins, then `providedVars` (env-style, then camelCase alias). */
function lookupProvided(
  field: FieldDef,
  serverInputs: Partial<ServerCreateInput> | undefined,
  providedVars: Record<string, string> | undefined,
): string | undefined {
  const typed = serverInputs?.[field.camel]
  if (typed !== undefined) return typed
  if (providedVars) {
    if (providedVars[field.envKey] !== undefined) return providedVars[field.envKey]
    if (providedVars[field.camel] !== undefined) return providedVars[field.camel]
  }
  return undefined
}

/**
 * Collect server-create inputs. Interactive (uses cliffy prompts) or
 * non-interactive (`failFast: true` — every field falls back to its
 * default, or throws a UserError naming the `--var` to pass).
 */
async function collectInput(
  serverInputs: Partial<ServerCreateInput> | undefined,
  providedVars: Record<string, string> | undefined,
  failFast?: boolean,
): Promise<ServerCreateInput> {
  const ask = (
    field: FieldDef,
    label: string,
    fallback: string | undefined,
    validate?: (v: string) => true | string,
  ) =>
    promptValue({
      key: field.envKey,
      label,
      provided: lookupProvided(field, serverInputs, providedVars),
      fallback,
      validate,
      nonInteractive: !!failFast,
    })

  const serverName = await ask(
    FIELDS.serverName,
    "Server name?",
    "home",
    (v) => (v.trim().length > 0 ? true : "server name required"),
  )
  // #208: fail fast on a bad name before asking anything else.
  validateServerName(serverName)

  // SSH target — any string. No validation (per Phase 5 user feedback).
  const sshTarget = await ask(
    FIELDS.sshTarget,
    "SSH target (alias or user@host)?",
    undefined,
    () => true,
  )

  // User — skip the prompt entirely when the SSH target already told us
  // (design §3.1 step 2). Interactive and non-interactive alike use the
  // parsed user unless explicitly overridden via --var.
  const parsedSsh = parseSshTarget(sshTarget)
  let user: string
  const providedUser = lookupProvided(FIELDS.user, serverInputs, providedVars)
  const sshTargetUser = parsedSsh.user
  if (sshTargetUser !== undefined) {
    user = providedUser ?? sshTargetUser
  } else if (providedUser !== undefined) {
    user = providedUser
  } else if (failFast) {
    user = await defaultShellUser()
  } else {
    user = await promptValue({
      key: FIELDS.user.envKey,
      label: "Remote user?",
      fallback: await defaultShellUser(),
    })
  }

  const domain = await ask(
    FIELDS.domain,
    "Primary domain for this server?",
    undefined,
    (v) => (v.includes(".") ? true : "expected a domain like example.com"),
  )
  const contactEmail = await ask(
    FIELDS.contactEmail,
    "Contact email (for Let's Encrypt ACME registration)?",
    undefined,
    (v) => (/^[^@]+@[^@]+\.[^@]+$/.test(v) ? true : "expected a valid email"),
  )
  const project = await ask(
    FIELDS.project,
    "Short project identifier?",
    "hl",
    (v) => (/^[a-z0-9_-]+$/i.test(v) ? true : "alphanumeric/dash/underscore only"),
  )

  // #207: probe the server once for the real docker group GID and the
  // SSH user's uid/gid, and use them as defaults — unless every one of
  // the three was already pre-supplied (skip the network round trip).
  const providedDockerGroupId = lookupProvided(FIELDS.dockerGroupId, serverInputs, providedVars)
  const providedPuid = lookupProvided(FIELDS.puid, serverInputs, providedVars)
  const providedPgid = lookupProvided(FIELDS.pgid, serverInputs, providedVars)
  let probed: ServerProbeResult = {}
  if (
    providedDockerGroupId === undefined || providedPuid === undefined || providedPgid === undefined
  ) {
    probed = await probeServer(sshTarget)
    if (probed.reason) console.log(`rostok: ${probed.reason}`)
  }

  const dockerGroupId = await ask(
    FIELDS.dockerGroupId,
    "Docker group ID (for /var/run/docker.sock access)?",
    probed.dockerGroupId ?? "990",
    (v) => (/^\d+$/.test(v) ? true : "must be a numeric group ID"),
  )

  // Detect host timezone as a default for TIMEZONE.
  const tzDefault = await detectTimezone()
  const timezone = await ask(FIELDS.timezone, "Timezone (IANA)?", tzDefault, () => true)

  const puid = await ask(
    FIELDS.puid,
    "Container user ID (PUID)?",
    probed.puid ?? "1000",
    (v) => (/^\d+$/.test(v) ? true : "must be a numeric user ID"),
  )
  const pgid = await ask(
    FIELDS.pgid,
    "Container group ID (PGID)?",
    probed.pgid ?? puid,
    (v) => (/^\d+$/.test(v) ? true : "must be a numeric group ID"),
  )
  const volumesPath = await ask(
    FIELDS.volumesPath,
    "Host directory for compose volumes?",
    "/srv/volumes",
    (v) => (v.startsWith("/") ? true : "must be an absolute path"),
  )
  const pathApps = await ask(
    FIELDS.pathApps,
    "Host directory where stacks are deployed?",
    DEFAULT_PATH_APPS,
    (v) => (v.startsWith("/") ? true : "must be an absolute path"),
  )

  return {
    serverName,
    sshTarget,
    user,
    domain,
    contactEmail,
    project,
    dockerGroupId,
    timezone,
    puid,
    pgid,
    volumesPath,
    pathApps,
  }
}

/** Detect host timezone via /etc/timezone (Debian/Ubuntu); fallback UTC. */
async function detectTimezone(): Promise<string> {
  try {
    const text = await Deno.readTextFile("/etc/timezone")
    return text.trim() || "UTC"
  } catch {
    return "UTC"
  }
}

/** Get the current shell user via `whoami` (falls back to $USER). */
async function defaultShellUser(): Promise<string> {
  return (await tryCaptureStdout("whoami")) ?? Deno.env.get("USER") ?? "rostok"
}

// ─────────────────────────────────────────────────────────────────────
// #207 — SSH probe for docker GID + PUID/PGID defaults.
// ─────────────────────────────────────────────────────────────────────

export interface ServerProbeResult {
  dockerGroupId?: string
  puid?: string
  pgid?: string
  /** One-line reason to print when a probe didn't fully succeed. */
  reason?: string
}

/**
 * Probe `target` once over SSH for the docker group GID (`getent group
 * docker`) and the SSH user's `id -u` / `id -g`. Best-effort: any SSH or
 * parsing failure returns a `reason` instead of throwing, and callers
 * fall back to today's static defaults. If the SSH user is root (uid 0),
 * PUID/PGID stay at the 1000/1000 default — containers shouldn't run as
 * root — but the docker GID still comes from the server.
 */
export async function probeServer(target: string): Promise<ServerProbeResult> {
  const remoteCmd = "echo DOCKER_GID=$(getent group docker 2>/dev/null | cut -d: -f3); " +
    "echo SSH_UID=$(id -u); echo SSH_GID=$(id -g)"

  let stdout: string
  let success: boolean
  let stderr: string
  try {
    const cmd = new Deno.Command("ssh", {
      args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", target, remoteCmd],
      stdout: "piped",
      stderr: "piped",
    })
    const out = await cmd.output()
    success = out.success
    stdout = new TextDecoder().decode(out.stdout)
    stderr = new TextDecoder().decode(out.stderr)
  } catch (err) {
    return {
      reason: `couldn't probe ${target} over SSH: ${
        err instanceof Error ? err.message : String(err)
      } — using default docker group ID / PUID / PGID.`,
    }
  }
  if (!success) {
    const firstLine = stderr.trim().split("\n")[0] || "ssh exited with a non-zero status"
    return {
      reason:
        `couldn't probe ${target} over SSH: ${firstLine} — using default docker group ID / PUID / PGID.`,
    }
  }

  const values: Record<string, string> = {}
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=")
    if (eq < 0) continue
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }

  const sshUid = values.SSH_UID
  const sshGid = values.SSH_GID
  const isRoot = sshUid === "0"
  const puid = sshUid ? (isRoot ? "1000" : sshUid) : undefined
  const pgid = sshGid ? (isRoot ? "1000" : sshGid) : undefined

  if (!values.DOCKER_GID) {
    return {
      puid,
      pgid,
      reason:
        `docker group not found on ${target} (is docker installed?) — using default docker group ID.`,
    }
  }
  return { dockerGroupId: values.DOCKER_GID, puid, pgid }
}
