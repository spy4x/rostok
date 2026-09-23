// Legacy key fallbacks deploy applies before enforcing DEPLOY_REQUIRED_KEYS
// (#206 deploy side).
//
// SSH_USER replaces HOMELAB_USER (read by the old deploy/ansible scripts)
// and USER (written by the wizard). Readers fall back HOMELAB_USER, then
// USER — read only from the parsed `.env` file, never from the process
// environment, where USER is the shell's own variable — and print a
// one-line notice so the operator renames the key.
//
// PATH_APPS falls back to DEFAULT_PATH_APPS (`/srv/apps`) when the server
// `.env` predates the wizard asking for it.

import { DEFAULT_PATH_APPS, DEPLOY_REQUIRED_KEYS } from "../server-keys.ts"
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

export interface ResolvedDeployEnv {
  /** `env` with SSH_USER and PATH_APPS filled in by the fallbacks above. */
  env: Record<string, string>
  /** One-line notices to print for every legacy key that was used. */
  notices: string[]
}

/**
 * Apply the legacy fallbacks, then throw a UserError naming every key of
 * DEPLOY_REQUIRED_KEYS still missing (and the file to fix) — deploy
 * cannot proceed without them.
 */
export function resolveDeployEnv(env: Record<string, string>, envPath: string): ResolvedDeployEnv {
  const notices: string[] = []

  const sshUser = resolveSshUser(env, envPath)
  if (sshUser.notice) notices.push(sshUser.notice)
  const pathApps = resolvePathApps(env)
  if (pathApps.notice) notices.push(pathApps.notice)

  const resolved: Record<string, string> = {
    ...env,
    ...(sshUser.value ? { SSH_USER: sshUser.value } : {}),
    PATH_APPS: pathApps.value,
  }

  const missing = DEPLOY_REQUIRED_KEYS.filter((key) => !resolved[key])
  if (missing.length > 0) {
    throw new UserError(
      `missing required key(s) in ${envPath}: ${missing.join(", ")}`,
    )
  }

  return { env: resolved, notices }
}
