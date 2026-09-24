// Server creation flow.
//
// Per docs/v1-cli.md §3.1 (Phase 5 user feedback):
// - Writes to `servers/<server>/.env` (NOT `.env.root`).
// - SSH target accepts an ssh_config alias (`homelab`) or `user@host`,
//   validated with `validateSshAddress` — the whole entered string, not
//   just the host part, since it's handed to `ssh`/`rsync` verbatim and
//   a leading `-` would be read as an option (`-oProxyCommand=...` runs
//   a local command). If `user@host`, the user is parsed and used
//   directly — the prompt is skipped entirely, interactive or not
//   (design §3.1 step 2). PATH_APPS/VOLUMES_PATH are validated with
//   `validateRemotePath` for the same reason: they reach the remote
//   shell through rsync/ssh.
// - The remote user is written as `SSH_USER` (#206/#209) — it's the only
//   remote-user key `.env` files carry.
// - Every field also accepts the env-style name that lands in `.env`
//   (SSH_ADDRESS, DOMAIN, ...) as a --var key, alongside the legacy
//   camelCase alias (sshTarget, domain, ...) for 1.x compatibility.
// - Re-running on an existing server defaults every field to what's
//   already in .env, not a static default — otherwise a re-run without
//   --var for every field would reset hand-tuned values (e.g. a
//   corrected DOCKER_GROUP_ID, or a deliberately non-default PUID/PGID)
//   back to a guess. DOCKER_GROUP_ID is the one field where a
//   *successful* SSH probe (#207) wins over the existing value, so
//   drift in the server's real docker group still self-corrects.
//   PUID/PGID do NOT get this treatment: they're not drift to correct —
//   they're the ownership every volume on disk was already chowned to,
//   so an existing value always wins over the probe (a successful probe
//   only fills the gap on a server that's never been created before).
// - Encryption is optional. If `age` is missing, the wizard still
//   runs to completion; the user runs `rostok env encrypt` manually
//   after installing age.

import { join } from "@std/path"
import { encryptEnvFiles } from "./encrypt.ts"
import { type EnvEntry, mergeEnv, readEnvFile, writeEnvFile } from "./env-files.ts"
import { type PromptFn, promptValue, withKeyLabel } from "./prompts.ts"
import { tryCaptureStdout } from "./shell.ts"
import {
  detectTimezone as detectTimezoneFromSources,
  remoteTimedatectlTimezone,
} from "./timezone.ts"
import {
  DEFAULT_PATH_APPS,
  parseSshAddress,
  serverDirFor,
  sshArgs,
  validateRemotePath,
  validateServerName,
  validateSshAddress,
} from "./server-keys.ts"

/** Adapt a throwing `validate*` function (server-keys.ts) to the `(v) => true | string` shape promptValue/cliffy expect. */
function toValidator(fn: (value: string) => void): (v: string) => true | string {
  return (v) => {
    try {
      fn(v)
      return true
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }
}

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
  /** Test injection point for every interactive prompt — see prompts.ts's PromptFn. */
  promptFn?: PromptFn
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
  const { input, existing } = await collectInput(
    cwd,
    opts.serverInputs,
    opts.providedVars,
    opts.failFast,
    opts.promptFn,
  )

  // Parse SSH target once. `user@host[:port]` → user hint; alias is preserved.
  const parsed = parseSshTarget(input.sshTarget)

  // #208: validated inside collectInput, before any prompt beyond the
  // name itself or any filesystem read/write — re-resolve here only to
  // get the same directory (cheap; the pattern check already ran).
  const serverDir = serverDirFor(cwd, input.serverName)
  const envPath = join(serverDir, ".env")

  await Deno.mkdir(join(serverDir, "configs"), { recursive: true })

  // #206: write every key scripts/deploy/+main.ts needs (DEPLOY_REQUIRED_KEYS
  // is a subset of this list) — SSH_USER always has a value (either parsed
  // from `user@host` or asked), PATH_APPS defaults to DEFAULT_PATH_APPS.
  const incoming: EnvEntry[] = [
    { key: "PROJECT", value: input.project },
    { key: "SSH_ADDRESS", value: input.sshTarget },
    { key: "SSH_USER", value: input.user },
    { key: "SERVER_NAME", value: input.serverName },
    { key: "DOMAIN", value: input.domain },
    { key: "CONTACT_EMAIL", value: input.contactEmail },
    { key: "DOCKER_GROUP_ID", value: input.dockerGroupId },
    { key: "TIMEZONE", value: input.timezone },
    { key: "PUID", value: input.puid },
    { key: "PGID", value: input.pgid },
    { key: "VOLUMES_PATH", value: input.volumesPath },
    { key: "PATH_APPS", value: input.pathApps },
  ]
  // #9: mergeEnv keeps each existing key in its original position when
  // updating its value — a re-run with unchanged values leaves the file
  // untouched, and a changed value doesn't jump to the bottom.
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
 * Split `user@host[:port]` into (user, address), reusing
 * `parseSshAddress` (server-keys.ts) for the actual user/host/port
 * parsing instead of duplicating it. `address` stays the raw text after
 * `user@` (brackets and all) — every caller here only reads `.user`;
 * `.address` is kept verbatim for {@link ServerCreateResult}'s public
 * shape. No `@` → `{}` for the user, caller prompts separately.
 */
function parseSshTarget(target: string): { user?: string; address: string } {
  const { user } = parseSshAddress(target)
  if (user === undefined) return { address: target }
  return { user, address: target.slice(target.indexOf("@") + 1) }
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
 * Collect server-create inputs, plus the (already-migrated) existing
 * `.env` entries for the caller to merge against. Interactive (uses
 * cliffy prompts) or non-interactive (`failFast: true` — every field
 * falls back to its default, or throws a UserError naming the `--var`
 * to pass).
 */
async function collectInput(
  cwd: string,
  serverInputs: Partial<ServerCreateInput> | undefined,
  providedVars: Record<string, string> | undefined,
  failFast?: boolean,
  promptFn?: PromptFn,
): Promise<{ input: ServerCreateInput; existing: EnvEntry[] }> {
  // #212: every label carries its `--var` key in parentheses, so a
  // hobbyist who wants to skip a prompt next time learns the exact flag
  // to pass — labels below are written for someone reading them cold,
  // with no docs open.
  const ask = (
    field: FieldDef,
    label: string,
    fallback: string | undefined,
    validate?: (v: string) => true | string,
  ) =>
    promptValue({
      key: field.envKey,
      label: withKeyLabel(label, field.envKey),
      provided: lookupProvided(field, serverInputs, providedVars),
      fallback,
      validate,
      nonInteractive: !!failFast,
      promptFn,
    })

  const serverName = await ask(
    FIELDS.serverName,
    "Server name, used as a folder name",
    "home",
    (v) => (v.trim().length > 0 ? true : "server name required"),
  )
  // #208: fail fast on a bad name before asking anything else.
  validateServerName(serverName)

  // #1 (review fix): now that the name is known and valid, read whatever
  // is already on disk so re-running server create defaults every field
  // to its current value instead of a static guess — otherwise a re-run
  // without --var for every field silently resets hand-tuned values
  // (e.g. a corrected DOCKER_GROUP_ID, or the SSH_USER an alias target
  // can't tell us on its own).
  const serverDir = serverDirFor(cwd, serverName)
  const envPath = join(serverDir, ".env")
  const existing = await readEnvFile(envPath)
  const existingByKey = new Map(existing.map((e) => [e.key, e.value]))

  // SSH target — an ssh_config alias or user@host[:port], validated by
  // `validateSshAddress`/`parseSshAddress` (security review): it's
  // handed to `ssh`/`rsync` verbatim, so a leading `-` or a space must
  // be rejected outright.
  const sshTarget = await ask(
    FIELDS.sshTarget,
    "SSH target: an ssh_config alias or user@host[:port]",
    existingByKey.get("SSH_ADDRESS"),
    toValidator(validateSshAddress),
  )

  const parsedSsh = parseSshTarget(sshTarget)
  const providedUser = lookupProvided(FIELDS.user, serverInputs, providedVars)
  const existingUser = existingByKey.get("SSH_USER")
  const sshTargetUser = parsedSsh.user

  // #2 (review fix): an alias target (no `user@` in the SSH_ADDRESS) with
  // no user anywhere yet — not provided, not already in .env — needs the
  // probe to ask the server who it's connecting as (`id -un`), instead of
  // guessing the *local* shell user, which is very often wrong.
  const needsRemoteUser = sshTargetUser === undefined && providedUser === undefined &&
    existingUser === undefined

  // #207: probe the server once for the real docker group GID and the
  // SSH user's uid/gid (+ username, #2 above), and use them as defaults
  // — unless every value the probe could supply is already pre-supplied
  // (skip the network round trip).
  const providedDockerGroupId = lookupProvided(FIELDS.dockerGroupId, serverInputs, providedVars)
  const providedPuid = lookupProvided(FIELDS.puid, serverInputs, providedVars)
  const providedPgid = lookupProvided(FIELDS.pgid, serverInputs, providedVars)
  let probed: ServerProbeResult = {}
  if (
    providedDockerGroupId === undefined || providedPuid === undefined ||
    providedPgid === undefined || needsRemoteUser
  ) {
    probed = await probeServer(sshTarget)
    if (probed.reason) {
      console.log(`rostok: ${probed.reason}${probeFallbackNote(probed, existingByKey)}`)
    }
  }

  // User — skip the prompt entirely when the SSH target already told us
  // (design §3.1 step 2). Interactive and non-interactive alike prefer,
  // in order: an explicit override, the parsed/existing user, the probed
  // remote username, then the local shell user as a last resort.
  let user: string
  if (sshTargetUser !== undefined) {
    user = providedUser ?? sshTargetUser
  } else if (providedUser !== undefined) {
    user = providedUser
  } else if (existingUser !== undefined) {
    user = existingUser
  } else {
    const remoteUserDefault = probed.sshUser ?? await defaultShellUser()
    user = failFast ? remoteUserDefault : await promptValue({
      key: FIELDS.user.envKey,
      label: withKeyLabel("Remote user, the SSH login used to deploy", FIELDS.user.envKey),
      fallback: remoteUserDefault,
      promptFn,
    })
  }

  const domain = await ask(
    FIELDS.domain,
    "Primary domain for this server, e.g. example.com",
    existingByKey.get("DOMAIN"),
    (v) => (v.includes(".") ? true : "expected a domain like example.com"),
  )
  const contactEmail = await ask(
    FIELDS.contactEmail,
    "Email for Let's Encrypt certificate notices",
    existingByKey.get("CONTACT_EMAIL"),
    (v) => (/^[^@]+@[^@]+\.[^@]+$/.test(v) ? true : "expected a valid email"),
  )
  const project = await ask(
    FIELDS.project,
    "Short project identifier, used to group this project's containers",
    existingByKey.get("PROJECT") ?? "hl",
    (v) => (/^[a-z0-9_-]+$/i.test(v) ? true : "alphanumeric/dash/underscore only"),
  )

  const dockerGroupId = await ask(
    FIELDS.dockerGroupId,
    "Docker group ID on the server, for /var/run/docker.sock access",
    probed.dockerGroupId ?? existingByKey.get("DOCKER_GROUP_ID") ?? "990",
    (v) => (/^\d+$/.test(v) ? true : "must be a numeric group ID"),
  )

  // Detect a timezone default — but an existing value always wins.
  // #212: TIMEZONE configures containers on the server, so the
  // server's own zone wins whenever it's knowable. Order (see
  // timezone.ts): the server's `timedatectl` over the SSH target —
  // only attempted when the #207 probe above already reached it, so a
  // dead target doesn't add a second hanging SSH round trip just for
  // this — then the local Intl zone, then local /etc/timezone, then UTC.
  const sshReachable = probed.dockerGroupId !== undefined || probed.puid !== undefined ||
    probed.pgid !== undefined || probed.sshUser !== undefined
  const tzDefault = existingByKey.get("TIMEZONE") ?? await detectTimezoneFromSources({
    remote: sshReachable ? () => remoteTimedatectlTimezone(sshTarget) : undefined,
  })
  const timezone = await ask(
    FIELDS.timezone,
    "Time zone for your apps, e.g. Europe/Berlin",
    tzDefault,
    () => true,
  )

  // Review fix: PUID/PGID are ownership already on disk, not drift to
  // correct — an existing value always wins over the probe (unlike
  // DOCKER_GROUP_ID above). A successful probe only fills the gap when
  // there's no existing value yet (a server being created for the
  // first time).
  const puid = await ask(
    FIELDS.puid,
    "Container user ID — the uid containers run as on the server",
    existingByKey.get("PUID") ?? probed.puid ?? "1000",
    (v) => (/^\d+$/.test(v) ? true : "must be a numeric user ID"),
  )
  const pgid = await ask(
    FIELDS.pgid,
    "Container group ID — the gid containers run as on the server",
    existingByKey.get("PGID") ?? probed.pgid ?? puid,
    (v) => (/^\d+$/.test(v) ? true : "must be a numeric group ID"),
  )
  // Remote paths reach the server's login shell through rsync/ssh
  // (security review) — validateRemotePath rejects shell metacharacters
  // (e.g. `/srv/$(x)`) and `..` segments, not just "starts with /".
  const volumesPath = await ask(
    FIELDS.volumesPath,
    "Folder on the server where app data is stored",
    existingByKey.get("VOLUMES_PATH") ?? "/srv/volumes",
    toValidator((v) => validateRemotePath("VOLUMES_PATH", v)),
  )
  const pathApps = await ask(
    FIELDS.pathApps,
    "Folder on the server where rostok puts your apps",
    existingByKey.get("PATH_APPS") ?? DEFAULT_PATH_APPS,
    toValidator((v) => validateRemotePath("PATH_APPS", v)),
  )

  return {
    input: {
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
    },
    existing,
  }
}

/** Get the current shell user via `whoami` (falls back to $USER). */
async function defaultShellUser(): Promise<string> {
  return (await tryCaptureStdout("whoami")) ?? Deno.env.get("USER") ?? "rostok"
}

// ─────────────────────────────────────────────────────────────────────
// #207 — SSH probe for docker GID + PUID/PGID + remote username defaults.
// ─────────────────────────────────────────────────────────────────────

export interface ServerProbeResult {
  dockerGroupId?: string
  puid?: string
  pgid?: string
  /** The SSH user's remote username (`id -un`) — the SSH_USER default for an alias target with no other known user. */
  sshUser?: string
  /** One-line reason to print when a probe didn't fully succeed. */
  reason?: string
}

/** Overall probe deadline — a hanging ssh (e.g. a firewall dropping packets) must never block the wizard. */
const PROBE_DEFAULT_DEADLINE_MS = 10_000

/**
 * Strip ASCII control characters (including DEL) before echoing an
 * untrusted SSH target into a log line or error message — same guard
 * as server-keys.ts's private `sanitizeForLog`, duplicated here since
 * that one isn't exported (server-keys.ts is outside this file's
 * ownership this wave). `target` reaches these messages verbatim
 * (probeServer is best-effort and never validates it beyond what
 * `validateSshAddress` already did upstream), so a value carrying a
 * newline or an escape sequence must not reach a terminal unescaped.
 */
function sanitizeTargetForLog(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, "")
}

/**
 * Probe `target` once over SSH for the docker group GID (`getent group
 * docker`), the SSH user's `id -u` / `id -g` / `id -un`. Best-effort: any
 * SSH failure, timeout, or parsing failure returns a `reason` instead of
 * throwing, and callers fall back to today's static defaults. If the SSH
 * user is root (uid 0), PUID/PGID stay at the 1000/1000 default —
 * containers shouldn't run as root — but the docker GID still comes from
 * the server.
 *
 * `StrictHostKeyChecking=accept-new` is required alongside `BatchMode`:
 * without it, an unknown host key (the common case on a fresh server)
 * makes the probe fail outright instead of accepting and continuing,
 * matching what a first-time interactive `ssh` to that host would do.
 * `deadlineMs` (default {@link PROBE_DEFAULT_DEADLINE_MS}) kills the ssh
 * process if it hasn't finished in time — exposed for tests.
 */
export async function probeServer(
  target: string,
  opts: { deadlineMs?: number } = {},
): Promise<ServerProbeResult> {
  const deadlineMs = opts.deadlineMs ?? PROBE_DEFAULT_DEADLINE_MS
  const remoteCmd = "echo DOCKER_GID=$(getent group docker 2>/dev/null | cut -d: -f3); " +
    "echo SSH_UID=$(id -u); echo SSH_GID=$(id -g); echo SSH_USER=$(id -un)"

  let child: Deno.ChildProcess
  try {
    // #218: build argv with `sshArgs` so a `SSH_ADDRESS` carrying a port
    // (`root@192.0.2.1:2222`) reaches ssh as `-p 2222 root@192.0.2.1`
    // instead of a single unresolvable "192.0.2.1:2222" hostname.
    // `StrictHostKeyChecking=accept-new` isn't part of `sshArgs`'s own
    // option set (it's specific to this first-contact probe), so it's
    // prepended here.
    const sshTarget = parseSshAddress(target)
    const args = [
      "-o",
      "StrictHostKeyChecking=accept-new",
      ...sshArgs(sshTarget, [remoteCmd], { batchMode: true }),
    ]
    child = new Deno.Command("ssh", {
      args,
      stdout: "piped",
      stderr: "piped",
    }).spawn()
  } catch (err) {
    return {
      reason: `couldn't probe ${sanitizeTargetForLog(target)} over SSH: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      child.kill("SIGKILL")
    } catch {
      // already exited between the timer firing and the kill call.
    }
  }, deadlineMs)

  let success: boolean
  let stdout: string
  let stderr: string
  try {
    const out = await child.output()
    success = out.success
    stdout = new TextDecoder().decode(out.stdout)
    stderr = new TextDecoder().decode(out.stderr)
  } finally {
    clearTimeout(timer)
  }

  if (timedOut) {
    return {
      reason: `couldn't probe ${
        sanitizeTargetForLog(target)
      } over SSH: timed out after ${deadlineMs}ms`,
    }
  }
  if (!success) {
    const firstLine = stderr.trim().split("\n")[0] ?? ""
    return {
      reason: `couldn't probe ${sanitizeTargetForLog(target)} over SSH: ${
        describeSshFailure(firstLine)
      }`,
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
  const sshUser = values.SSH_USER || undefined

  if (!values.DOCKER_GID) {
    return {
      puid,
      pgid,
      sshUser,
      reason: `docker group not found on ${sanitizeTargetForLog(target)} (is docker installed?)`,
    }
  }
  return { dockerGroupId: values.DOCKER_GID, puid, pgid, sshUser }
}

/**
 * Build the trailing "— keeping the saved X / using the default Y" clause
 * for a probe-failure `reason`, naming exactly which of DOCKER_GROUP_ID,
 * PUID, PGID the probe didn't supply and whether each already has a
 * value in the server's `.env` (review fix: "using default" was wrong —
 * and worrying — on a re-run where the value survives untouched).
 */
function probeFallbackNote(
  probed: ServerProbeResult,
  existingByKey: Map<string, string>,
): string {
  const missing: string[] = []
  if (probed.dockerGroupId === undefined) missing.push("DOCKER_GROUP_ID")
  if (probed.puid === undefined) missing.push("PUID")
  if (probed.pgid === undefined) missing.push("PGID")
  if (missing.length === 0) return "."

  const kept = missing.filter((k) => existingByKey.has(k))
  const defaulted = missing.filter((k) => !existingByKey.has(k))
  const parts: string[] = []
  if (kept.length > 0) parts.push(`keeping the saved ${kept.join("/")}`)
  if (defaulted.length > 0) parts.push(`using the default ${defaulted.join("/")}`)
  return ` — ${parts.join(", ")}.`
}

/** Turn ssh's first stderr line into a short, specific reason instead of raw ssh text. */
function describeSshFailure(stderrFirstLine: string): string {
  const s = stderrFirstLine.toLowerCase()
  if (s.includes("timed out") || s.includes("timeout")) return "connection timed out"
  if (s.includes("host key verification failed") || s.includes("identification has changed")) {
    return "host key verification failed"
  }
  if (s.includes("permission denied") || s.includes("authentication")) {
    return "authentication failed"
  }
  if (s.includes("could not resolve hostname") || s.includes("name or service not known")) {
    return "couldn't resolve the host"
  }
  return stderrFirstLine || "ssh exited with a non-zero status"
}
