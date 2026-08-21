// Server creation flow.
//
// Per docs/v1-cli.md §3.1 step 2:
//
//   - Server name
//   - SSH target as a single alias string: `user@host:port` (port
//     defaults to 22 if omitted). Stored verbatim.
//   - Domain
//   - Contact email
//   - `~/.rostok/secrets/` for the age key, age64-encrypted (gitignored)
//
// Phase 4 user feedback extended the well-known server-level refs to
// include `${DOMAIN}`, `${TIMEZONE}`, `${PUID}`, `${PGID}`, `${VOLUMES_PATH}`.
// Server-create populates the corresponding .env.root keys so stacks can
// reference them via `${KEY}` substitution.
//
// SSH_ADDRESS is parsed into SSH_ADDRESS + HOMELAB_USER (the user part)
// for compatibility with scripts/deploy/+main.ts (which reads both).
//
// `.env.root` keys written:
//   SERVER_NAME       server name (also the dir name under servers/)
//   SSH_ADDRESS       full user@host:port (verbatim)
//   HOMELAB_USER      user part of SSH target
//   DOMAIN            apex domain (e.g. example.com)
//   CONTACT_EMAIL     ACME registration contact
//   TIMEZONE          IANA tz (e.g. Europe/Berlin)
//   PUID              container user ID (linuxserver.io)
//   PGID              container group ID
//   VOLUMES_PATH      host dir for compose volumes

import { Input } from "@cliffy/prompt"
import { join } from "@std/path"
import { encryptEnvFiles } from "./encrypt.ts"
import { type EnvEntry, mergeEnv, readEnvFile, writeEnvFile } from "./env-files.ts"

/** Result of a server-create invocation. */
export interface ServerCreateResult {
  serverName: string
  /** Path to the .env.root file (relative to cwd). */
  envRootPath: string
  /** Path to the servers/<name>/ directory (relative to cwd). */
  serverDir: string
}

export interface ServerCreateOptions {
  /**
   * Pre-supplied inputs. Keys present here skip their prompt. Missing
   * keys trigger a prompt unless `nonInteractive` is also set.
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

/**
 * Subset of the server-create inputs that can be pre-supplied via
 * --var-style flags. Phase 5 power-user API: `--server=home
 * --ssh=user@host:22 --domain=...`.
 *
 * Phase 5 ships the structural shape; richer flag parsing arrives with
 * Phase 5b alongside `--var KEY=VAL` for stack add.
 */
export interface ServerCreateInput {
  serverName: string
  sshTarget: string
  domain: string
  contactEmail: string
  timezone: string
  puid: string
  pgid: string
  volumesPath: string
}

/**
 * Run the server creation flow. Interactive prompts unless `nonInteractive`
 * is set; in non-interactive mode, all required inputs must be pre-supplied.
 *
 * Writes `.env.root` (server-level vars) and creates `servers/<name>/`.
 * Re-encrypts `.env.root` to `.env.root.age` at the end.
 */
export async function serverCreate(opts: ServerCreateOptions = {}): Promise<ServerCreateResult> {
  const cwd = opts.cwd ?? Deno.cwd()
  const input = await collectInput(opts.nonInteractive, opts.failFast)

  // Parse SSH target into user@host:port + HOMELAB_USER.
  const sshTarget = input.sshTarget
  const atSign = sshTarget.lastIndexOf("@")
  if (atSign < 1) {
    throw new Error(`invalid SSH target: ${sshTarget} (expected user@host[:port])`)
  }
  const homelabUser = sshTarget.slice(0, atSign)
  const hostPort = sshTarget.slice(atSign + 1)
  if (!hostPort) {
    throw new Error(`invalid SSH target: ${sshTarget} (missing host)`)
  }

  // 1. Read existing .env.root (preserve unknown keys, e.g. PATH_*).
  const envRootPath = join(cwd, ".env.root")
  const existing = await readEnvFile(envRootPath)

  // 2. Compose the new entries. Order: existing (minus overwritten) first,
  //    then incoming. mergeEnv handles the dedup.
  const incoming: EnvEntry[] = [
    { key: "SERVER_NAME", value: input.serverName },
    { key: "SSH_ADDRESS", value: sshTarget },
    { key: "HOMELAB_USER", value: homelabUser },
    { key: "DOMAIN", value: input.domain },
    { key: "CONTACT_EMAIL", value: input.contactEmail },
    { key: "TIMEZONE", value: input.timezone },
    { key: "PUID", value: input.puid },
    { key: "PGID", value: input.pgid },
    { key: "VOLUMES_PATH", value: input.volumesPath },
  ]
  const merged = mergeEnv(existing, incoming)

  // 3. Write .env.root atomically.
  await writeEnvFile(envRootPath, merged)

  // 4. Create servers/<name>/ skeleton (idempotent).
  const serverDir = join(cwd, "servers", input.serverName)
  await Deno.mkdir(join(serverDir, "configs"), { recursive: true })

  // 5. Re-encrypt .env.root → .env.root.age (non-fatal).
  await encryptEnvFiles(cwd)

  return {
    serverName: input.serverName,
    envRootPath,
    serverDir,
  }
}

/**
 * Collect server-create inputs. Interactive (uses cliffy prompts) or
 * non-interactive (caller pre-supplies via `pre`).
 *
 * When `failFast` is true, missing inputs throw instead of prompting
 * (docs/v1-cli.md §3.4 strict-default policy). The CLI passes `failFast`
 * when the user sets `--non-interactive`.
 */
async function collectInput(
  pre: Partial<ServerCreateInput> | undefined,
  failFast?: boolean,
): Promise<ServerCreateInput> {
  const ask = async (
    label: string,
    fallback: string | undefined,
    validate: (v: string) => true | string,
  ): Promise<string> => {
    const preValue = pre?.[label as keyof ServerCreateInput]
    if (preValue !== undefined) return preValue
    if (failFast) {
      throw new Error(
        `server-create: missing required value '${label}' in non-interactive mode. ` +
          `pass via --var or positional argument.`,
      )
    }
    return await Input.prompt({ message: label, default: fallback, validate })
  }

  const serverName = await ask(
    "serverName",
    "home",
    (v) => (v.trim().length > 0 ? true : "server name required"),
  )
  const sshTarget = await ask(
    "sshTarget",
    undefined,
    (v) => (/^[^@]+@[^@]+(:\d+)?$/.test(v) ? true : "expected user@host[:port]"),
  )
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
    domain,
    contactEmail,
    timezone,
    puid,
    pgid,
    volumesPath,
  }
}

/** Detect host timezone via /etc/timezone (Linux) or /etc/localtime symlink. */
async function detectTimezone(): Promise<string> {
  try {
    const text = await Deno.readTextFile("/etc/timezone")
    return text.trim() || "UTC"
  } catch {
    return "UTC"
  }
}
