// Server creation flow.
//
// Per docs/v1-cli.md §3.1 (Phase 5 user feedback):
// - Writes to `servers/<server>/.env` (NOT `.env.root`).
// - SSH target accepts any string: ssh_config alias (`homelab`),
//   connection string (`user@host[:port]`), or just a hostname.
//   No validation. If `user@host`, the user is extracted and used as
//   the hint for the next USER prompt (which can be skipped).
// - USER renamed from HOMELAB_USER; matches scripts/deploy/+main.ts
//   convention (it reads `SSH_ADDRESS` and `HOMELAB_USER` — we keep
//   the project-agnostic `USER` here; deploy scripts translate).
// - Encryption is optional. If `age` is missing, the wizard still
//   runs to completion; the user runs `deno task env:encrypt`
//   manually after installing age.

import { join } from "@std/path"
import { encryptEnvFiles } from "./encrypt.ts"
import { type EnvEntry, mergeEnv, readEnvFile, writeEnvFile } from "./env-files.ts"
import { promptValue } from "./prompts.ts"
import { tryCaptureStdout } from "./shell.ts"

/** Result of a server-create invocation. */
export interface ServerCreateResult {
  serverName: string
  /** Path to `servers/<name>/` (relative to cwd). */
  serverDir: string
  /** Path to `servers/<name>/.env` (relative to cwd). */
  envPath: string
  /** Parsed SSH target — `USER` (if any) plus the verbatim address. */
  parsedSsh: { user?: string; address: string }
}

export interface ServerCreateOptions {
  /**
   * Pre-supplied inputs. Keys present here skip their prompt. Missing
   * keys trigger a prompt unless `failFast` is also set.
   */
  nonInteractive?: Partial<ServerCreateInput>
  /**
   * Skip prompts entirely; fail loudly on any missing required input.
   * Per docs/v1-cli.md §3.4 strict-default policy.
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
}

/**
 * Run the server creation flow. Writes `servers/<name>/.env` and the
 * `configs/` subdirectory. Re-encrypts the per-server `.env.age` (no-op
 * if `age` isn't installed — see cli/encrypt.ts).
 */
export async function serverCreate(opts: ServerCreateOptions = {}): Promise<ServerCreateResult> {
  const cwd = opts.cwd ?? Deno.cwd()
  const input = await collectInput(opts.nonInteractive, opts.failFast)

  // Parse SSH target once. `user@host[:port]` → user hint; alias is preserved.
  const parsed = parseSshTarget(input.sshTarget)

  // 1. Write per-server .env. Read existing first to preserve unknown keys
  //    (e.g. PATH_* the user added by hand).
  const serverDir = join(cwd, "servers", input.serverName)
  const envPath = join(serverDir, ".env")
  await Deno.mkdir(join(serverDir, "configs"), { recursive: true })
  const existing = await readEnvFile(envPath)

  const incoming: EnvEntry[] = [
    { key: "PROJECT", value: input.project },
    { key: "SSH_ADDRESS", value: input.sshTarget },
    // USER only if known — phase 5: SSH `user@host` parses, alias prompts.
    ...(input.user ? [{ key: "USER", value: input.user }] as EnvEntry[] : []),
    { key: "DOMAIN", value: input.domain },
    { key: "CONTACT_EMAIL", value: input.contactEmail },
    { key: "DOCKER_GROUP_ID", value: input.dockerGroupId },
    { key: "TIMEZONE", value: input.timezone },
    { key: "PUID", value: input.puid },
    { key: "PGID", value: input.pgid },
    { key: "VOLUMES_PATH", value: input.volumesPath },
  ]
  const merged = mergeEnv(existing, incoming)
  await writeEnvFile(envPath, merged)

  // 2. Re-encrypt (non-fatal — see cli/encrypt.ts).
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

/**
 * Collect server-create inputs. Interactive (uses cliffy prompts) or
 * non-interactive (caller pre-supplies via `pre`).
 *
 * When `failFast` is true, missing inputs throw instead of prompting
 * (docs/v1-cli.md §3.4).
 */
async function collectInput(
  pre: Partial<ServerCreateInput> | undefined,
  failFast?: boolean,
): Promise<ServerCreateInput> {
  const ask = (
    label: keyof ServerCreateInput,
    fallback: string | undefined,
    validate?: (v: string) => true | string,
  ) =>
    promptValue({
      label,
      provided: pre?.[label],
      fallback,
      validate,
      nonInteractive: !!failFast,
    })

  const serverName = await ask(
    "serverName",
    "home",
    (v) => (v.trim().length > 0 ? true : "server name required"),
  )
  // SSH target — any string. No validation (per Phase 5 user feedback).
  const sshTarget = await ask("sshTarget", undefined, () => true)

  // User — only prompt if SSH target didn't tell us. If user@host, the
  // user part is the default (editable). If alias, prompt fresh with the
  // current shell user as the default hint.
  const parsedSsh = parseSshTarget(sshTarget)
  let user: string
  if (parsedSsh.user !== undefined) {
    // Pre-supplied takes priority; otherwise confirm via prompt (editable
    // default lets user keep or change).
    if (pre?.user !== undefined) {
      user = pre.user
    } else if (failFast) {
      throw new Error(
        `server-create: SSH target "${sshTarget}" doesn't include a user; ` +
          `pass --var user=... in non-interactive mode.`,
      )
    } else {
      user = await promptValue({
        label: "user",
        fallback: parsedSsh.user,
      })
    }
  } else {
    user = await ask(
      "user",
      await defaultShellUser(),
      () => true,
    )
  }

  const domain = await ask(
    "domain",
    undefined,
    (v) => (v.includes(".") ? true : "expected a domain like example.com"),
  )
  const contactEmail = await ask(
    "contactEmail",
    undefined,
    (v) => (/^[^@]+@[^@]+\.[^@]+$/.test(v) ? true : "expected a valid email"),
  )
  const project = await ask(
    "project",
    "hl",
    (v) => (/^[a-z0-9_-]+$/i.test(v) ? true : "alphanumeric/dash/underscore only"),
  )
  const dockerGroupId = await ask(
    "dockerGroupId",
    "990",
    (v) => (/^\d+$/.test(v) ? true : "must be a numeric group ID"),
  )

  // Detect host timezone as a default for TIMEZONE.
  const tzDefault = await detectTimezone()
  const timezone = await ask("timezone", tzDefault, () => true)

  const puid = await ask(
    "puid",
    "1000",
    (v) => (/^\d+$/.test(v) ? true : "must be a numeric user ID"),
  )
  const pgid = await ask(
    "pgid",
    puid,
    (v) => (/^\d+$/.test(v) ? true : "must be a numeric group ID"),
  )
  const volumesPath = await ask(
    "volumesPath",
    "/srv/volumes",
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
