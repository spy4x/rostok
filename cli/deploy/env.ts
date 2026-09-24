// Key fallbacks deploy applies before enforcing DEPLOY_REQUIRED_KEYS
// (#206 deploy side).
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
//
// (#223) VOLUMES_PATH written as `${PATH_APPS}/.volumes` (or
// `$PATH_APPS/...`) is expanded against the already-loaded env — the
// same reference docker compose itself resolves when it reads the same
// `.env` — before the plain-absolute-path check runs. `server
// create`'s own prompt already rejects a `${...}` value outright
// (`validateRemotePath` disallows `$`/`{`/`}`), so this only matters for
// a `.env` written or edited by hand, or by an older rostok version, and
// never for one `server create` (as of #223) still produces. An
// undefined reference is a UserError naming it — silently leaving
// `${TYPO}` in the path would otherwise reach ssh/rsync as a literal,
// nonexistent directory name.
//
// SSH_USER/SSH_ADDRESS agreement: a hook must log in as the same user
// deploy's own ssh/rsync calls do. Deploy's login user is the user part
// of SSH_ADDRESS when it has one (or ssh_config's own User for a bare
// alias — rostok never sees that). SSH_USER is the separate remote
// username `server create` writes (normally the same user, extracted
// from `user@host` at server-create time, but a `--var` flag can set
// it independently). When SSH_ADDRESS DOES carry a user and it disagrees
// with SSH_USER, a hook (which gets SSH_USER, not the address's own
// user) would silently log in as someone else than deploy's own ssh
// calls do — refused as a UserError naming both values. A bare-alias
// SSH_ADDRESS (no user part) has nothing to compare against, so it's
// never flagged here.

import {
  DEFAULT_PATH_APPS,
  DEPLOY_REQUIRED_KEYS,
  parseSshAddress,
  validateRemotePath,
  validateSshAddress,
} from "../server-keys.ts"
import { UserError } from "../errors.ts"

/**
 * Expand `${VAR}` and bare `$VAR` references in `value` against `env`,
 * the way docker compose resolves the same `.env` file. Only a plain
 * variable reference is supported — no `:-default`, `:?msg`, nesting,
 * or `$$` escape (VOLUMES_PATH/PATH_APPS never need those; compose's own
 * fuller grammar is out of scope here). Throws a UserError naming `key`
 * and the undefined reference — a silently-unexpanded `${TYPO}` would
 * otherwise reach ssh/rsync as a literal, nonexistent path segment.
 */
export function expandEnvRefs(key: string, value: string, env: Record<string, string>): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, braced: string | undefined, bare: string | undefined) => {
      const ref = braced ?? bare!
      const resolved = env[ref]
      if (resolved === undefined) {
        throw new UserError(`invalid ${key} "${value}": references undefined variable "${ref}".`)
      }
      return resolved
    },
  )
}

export interface ResolvedValue {
  value: string
  /** One-line notice to print when a legacy key was used, undefined otherwise. */
  notice?: string
}

/**
 * SSH_USER, read only from `env` (never Deno.env, where USER is the
 * shell's own variable). No fallback and never a notice — unlike
 * PATH_APPS/PUID/PGID below, there's no safe default for a remote user.
 */
export function resolveSshUser(env: Record<string, string>): string {
  return env.SSH_USER ?? ""
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

  const sshUser = resolveSshUser(env)
  const pathApps = resolvePathApps(env)
  if (pathApps.notice) notices.push(pathApps.notice)
  const puid = resolvePuid(env)
  if (puid.notice) notices.push(puid.notice)
  const pgid = resolvePgid(env)
  if (pgid.notice) notices.push(pgid.notice)

  const resolved: Record<string, string> = {
    ...env,
    ...(sshUser ? { SSH_USER: sshUser } : {}),
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

  // Expand ${VAR}/$VAR references (e.g. VOLUMES_PATH=${PATH_APPS}/.volumes)
  // before the plain-absolute-path check — see the module comment (#223).
  // PATH_APPS expands first so a VOLUMES_PATH that references it sees the
  // final value, not an unexpanded one.
  resolved.PATH_APPS = expandEnvRefs("PATH_APPS", resolved.PATH_APPS, resolved)
  resolved.VOLUMES_PATH = expandEnvRefs("VOLUMES_PATH", resolved.VOLUMES_PATH, resolved)

  // Before any of these reaches ssh/rsync or a remote shell command:
  // reject an SSH_ADDRESS that could be read as an option, and a
  // PATH_APPS/VOLUMES_PATH that isn't a plain absolute path.
  validateSshAddress(resolved.SSH_ADDRESS)
  validateRemotePath("PATH_APPS", resolved.PATH_APPS)
  validateRemotePath("VOLUMES_PATH", resolved.VOLUMES_PATH)

  // A hook logs in with SSH_USER (cli/deploy/hooks.ts's contract key);
  // deploy's own ssh/rsync calls log in with SSH_ADDRESS's own user part
  // when it has one. The two must agree, or a hook silently logs in as
  // someone else than the rest of deploy does — see the module comment.
  const addressUser = parseSshAddress(resolved.SSH_ADDRESS).user
  if (addressUser !== undefined && addressUser !== resolved.SSH_USER) {
    throw new UserError(
      `SSH_ADDRESS's user "${addressUser}" disagrees with SSH_USER "${resolved.SSH_USER}" ` +
        `(${envPath}) — a hook logs in as SSH_USER, deploy's own ssh/rsync calls log in as ` +
        `SSH_ADDRESS's user; they must be the same account.`,
    )
  }

  return { env: resolved, notices }
}
