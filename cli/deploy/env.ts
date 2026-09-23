// Legacy key fallbacks deploy applies before enforcing DEPLOY_REQUIRED_KEYS
// (#206 deploy side).
//
// SSH_USER replaces HOMELAB_USER (read by the old deploy/ansible scripts)
// and USER (written by the wizard). Readers fall back HOMELAB_USER, then
// USER — read only from the parsed `.env` file, never from the process
// environment, where USER is the shell's own variable — and print a
// one-line notice so the operator renames the key.
//
// PATH_APPS falls back to DEFAULT_PATH_APPS (`/srv/apps`), and PUID/PGID
// fall back to `1000` (rostok's own default — docs/design/v1-cli.md §3.1,
// `server-create.ts`'s own prompt default), when the server `.env`
// predates the wizard asking for them.
//
// `resolveDeployEnv` takes the server `.env` already merged with
// `.env.root` (the caller's job — see run-deploy.ts), because compose
// itself reads both (`--env-file=.env.root --env-file=.env`): a required
// key genuinely declared in `.env.root` (a cross-server value) must not
// be reported missing just because it isn't repeated in the server file.
//
// SSH_ADDRESS, PATH_APPS and VOLUMES_PATH are validated here too, before
// any of them reaches an `ssh`/`rsync` argv or a remote path: an
// `SSH_ADDRESS` starting with `-` (`-oProxyCommand=<cmd>`) runs `<cmd>`
// on the machine running rostok the moment ssh (or rsync, which
// re-spawns ssh with the same target) parses it as an option instead of
// a destination.

import {
  DEFAULT_PATH_APPS,
  DEPLOY_REQUIRED_KEYS,
  validateRemotePath,
  validateSshAddress,
} from "../server-keys.ts"
import { UserError } from "../errors.ts"

export interface ResolvedValue {
  value: string
  /** One-line notice to print when a legacy key was used, undefined otherwise. */
  notice?: string
}

/** SSH_USER ← HOMELAB_USER ← USER, read only from `env` (never Deno.env). */
export function resolveSshUser(env: Record<string, string>, envPath: string): ResolvedValue {
  if (env.SSH_USER) return { value: env.SSH_USER }
  if (env.HOMELAB_USER) {
    return {
      value: env.HOMELAB_USER,
      notice: `${envPath}: HOMELAB_USER is deprecated — rename it to SSH_USER.`,
    }
  }
  if (env.USER) {
    return {
      value: env.USER,
      notice: `${envPath}: USER is deprecated — rename it to SSH_USER.`,
    }
  }
  return { value: "" }
}

/** PATH_APPS ← DEFAULT_PATH_APPS. */
export function resolvePathApps(env: Record<string, string>): ResolvedValue {
  if (env.PATH_APPS) return { value: env.PATH_APPS }
  return {
    value: DEFAULT_PATH_APPS,
    notice: `PATH_APPS not set — using the default ${DEFAULT_PATH_APPS}.`,
  }
}

/** The PUID/PGID default `server create` itself prompts with. */
export const DEFAULT_ID = "1000"

/** PUID ← DEFAULT_ID (1000). */
export function resolvePuid(env: Record<string, string>): ResolvedValue {
  if (env.PUID) return { value: env.PUID }
  return { value: DEFAULT_ID, notice: `PUID not set — using the default ${DEFAULT_ID}.` }
}

/** PGID ← DEFAULT_ID (1000). */
export function resolvePgid(env: Record<string, string>): ResolvedValue {
  if (env.PGID) return { value: env.PGID }
  return { value: DEFAULT_ID, notice: `PGID not set — using the default ${DEFAULT_ID}.` }
}

export interface ResolvedDeployEnv {
  /** `env` with SSH_USER and PATH_APPS filled in by the fallbacks above. */
  env: Record<string, string>
  /** One-line notices to print for every legacy key that was used. */
  notices: string[]
}

/**
 * Apply the legacy fallbacks, then throw a UserError naming every key of
 * DEPLOY_REQUIRED_KEYS still missing (and the files to fix) — deploy
 * cannot proceed without them.
 *
 * `env` must already be `.env.root` merged with the server `.env` (server
 * wins on conflict — see the module comment above); `envPath` and
 * `rootEnvPath` are only used to name the files in notices and errors.
 */
export function resolveDeployEnv(
  env: Record<string, string>,
  envPath: string,
  rootEnvPath: string,
): ResolvedDeployEnv {
  const notices: string[] = []

  const sshUser = resolveSshUser(env, envPath)
  if (sshUser.notice) notices.push(sshUser.notice)
  const pathApps = resolvePathApps(env)
  if (pathApps.notice) notices.push(pathApps.notice)
  const puid = resolvePuid(env)
  if (puid.notice) notices.push(puid.notice)
  const pgid = resolvePgid(env)
  if (pgid.notice) notices.push(pgid.notice)

  const resolved: Record<string, string> = {
    ...env,
    ...(sshUser.value ? { SSH_USER: sshUser.value } : {}),
    PATH_APPS: pathApps.value,
    PUID: puid.value,
    PGID: pgid.value,
  }

  const missing = DEPLOY_REQUIRED_KEYS.filter((key) => !resolved[key])
  if (missing.length > 0) {
    throw new UserError(
      `missing required key(s) in ${envPath} (also checked ${rootEnvPath}): ${missing.join(", ")}`,
    )
  }

  // Before any of these reaches ssh/rsync or a remote shell command:
  // reject an SSH_ADDRESS that could be read as an option, and a
  // PATH_APPS/VOLUMES_PATH that isn't a plain absolute path.
  validateSshAddress(resolved.SSH_ADDRESS)
  validateRemotePath("PATH_APPS", resolved.PATH_APPS)
  validateRemotePath("VOLUMES_PATH", resolved.VOLUMES_PATH)

  return { env: resolved, notices }
}
