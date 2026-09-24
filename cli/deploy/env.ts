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
// (#233) VOLUMES_PATH must never sit inside PATH_APPS, nor the reverse,
// nor equal it — checked with server-keys.ts's pathsNestedOrEqual
// (path-component-wise, after the expansion above, never a raw string
// prefix) once both are resolved. A full deploy now syncs PATH_APPS with
// `rsync --delete`, so app data living inside it would be wiped the
// moment a stack it belongs to stops shipping a file deploy expects
// there. The error names the real, expanded paths and the steps to move
// the data — `server create` already defaults to sibling paths
// (/srv/apps, /srv/volumes); this only fires for a `.env` written or
// edited by hand, or by an older rostok version.
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
  normalizeRemotePath,
  parseSshAddress,
  pathComponents,
  pathsNestedOrEqual,
  validateRemotePath,
  validateSshAddress,
  validateSshUser,
} from "../server-keys.ts"
import { UserError } from "../errors.ts"

/**
 * Build the UserError message for a nested/equal PATH_APPS/VOLUMES_PATH
 * pair (#233), picking the right migration steps for WHICH direction the
 * nesting runs — `mv`-ing `VOLUMES_PATH` out only makes sense when it's
 * the one sitting inside `PATH_APPS`; telling the operator to move it
 * when `PATH_APPS` is the one nested inside `VOLUMES_PATH` would tell
 * them to `mv` the very folder that also holds `PATH_APPS`.
 */
function buildNestedPathsError(pathApps: string, volumesPath: string, envPath: string): string {
  const reencrypt = "re-encrypt (`rostok env encrypt`)"
  const stopStacks = "stop each stack on the server (from PATH_APPS, run `docker compose -p " +
    "<name> --env-file .env.root --env-file .env -f stacks/<name>/compose.yml down` for each " +
    "stacks/<name> — a plain `docker compose down` run from inside the folder can silently " +
    "target the wrong project for a stack whose compose.yml sets `name: ${PROJECT}`)"

  if (pathApps === volumesPath) {
    return `VOLUMES_PATH and PATH_APPS must not be the same directory ("${pathApps}") — a ` +
      `full deploy syncs PATH_APPS with rsync --delete, which would wipe VOLUMES_PATH's data ` +
      `too. Point them at sibling directories instead (e.g. /srv/apps and /srv/volumes), ` +
      `update ${envPath}, ${reencrypt}, and redeploy.`
  }
  if (pathComponents(pathApps).length > pathComponents(volumesPath).length) {
    // PATH_APPS is the one nested inside VOLUMES_PATH — VOLUMES_PATH is
    // the ANCESTOR here, so it's never the one to move.
    return `PATH_APPS "${pathApps}" must live outside VOLUMES_PATH "${volumesPath}" — a full ` +
      `deploy syncs PATH_APPS with rsync --delete, and VOLUMES_PATH must never be an ` +
      `ancestor of it either, or a bug in that sync could reach data outside PATH_APPS. ` +
      `Point PATH_APPS and VOLUMES_PATH at sibling directories instead (e.g. /srv/apps and ` +
      `/srv/volumes) — never move VOLUMES_PATH here, since it currently CONTAINS PATH_APPS. ` +
      `${stopStacks}, move PATH_APPS's own data if it has any outside compose volumes, update ` +
      `PATH_APPS and/or VOLUMES_PATH in ${envPath}, ${reencrypt}, and redeploy.`
  }
  // The common case: VOLUMES_PATH nested inside PATH_APPS.
  return `VOLUMES_PATH "${volumesPath}" must live outside PATH_APPS "${pathApps}" — a full ` +
    `deploy now syncs PATH_APPS with rsync --delete, which would wipe app data stored inside ` +
    `it. To move the data: 1) ${stopStacks}, 2) move the data folder on the server ` +
    `(\`mv ${volumesPath} <new path>\`, a sibling of PATH_APPS, e.g. /srv/volumes next to ` +
    `/srv/apps), 3) set VOLUMES_PATH to the new path in ${envPath} and ${reencrypt}, ` +
    `4) redeploy.`
}

/**
 * True for a key safe to substitute into VOLUMES_PATH/PATH_APPS: a
 * path-SHAPED name — `PATH_*` (isServerKey()'s own pattern, e.g.
 * PATH_MEDIA) or `*_PATH` (VOLUMES_PATH itself, and a server's own
 * naming for a shared root, e.g. BASE_PATH=/home/user/apps with
 * PATH_APPS=${BASE_PATH}/rostok) — never a value's own content.
 * Deliberately NOT every server key (DOMAIN, SSH_ADDRESS, ...), and
 * never a stack's own secret (STALWART_ADMIN_PASSWORD and friends can
 * live in the same server `.env`) — see expandEnvRefs's own comment
 * for why the allow-list goes by name, not by value.
 */
function isExpandablePathKey(key: string): boolean {
  return /^PATH_[A-Z0-9_]+$/.test(key) || /^[A-Z0-9_]+_PATH$/.test(key)
}

/**
 * Expand `${VAR}` and bare `$VAR` references in `value` against `env`,
 * the way docker compose resolves the same `.env` file — but ONLY for a
 * path-shaped key name, `PATH_*` or `*_PATH` (`isExpandablePathKey`),
 * never any other name. `validateRemotePath`
 * echoes its OWN argument back verbatim in its error message once this
 * returns, so a reference to an arbitrary key (`VOLUMES_PATH=/x/${
 * STALWART_ADMIN_PASSWORD}`, say — a stack secret can live in the same
 * server `.env`) would print that secret's value straight into a
 * UserError, which reaches logs/terminals. Refusing the reference
 * outright, naming only the KEY it names (never a value, from either
 * side), closes that: the error below is always safe to print.
 *
 * `$$` is compose's own escape for a literal `$` (never a reference) —
 * handled the same way here so `VOLUMES_PATH=/x/$$literal` behaves
 * identically to how compose itself would read it.
 *
 * Only a plain variable reference is supported — no `:-default`,
 * `:?msg`, or nesting (VOLUMES_PATH/PATH_APPS never need those;
 * compose's own fuller grammar is out of scope here). Throws a
 * UserError naming `key` and the undefined/disallowed reference — a
 * silently-unexpanded `${TYPO}` would otherwise reach ssh/rsync as a
 * literal, nonexistent path segment.
 */
export function expandEnvRefs(key: string, value: string, env: Record<string, string>): string {
  // Placeholder outside the printable-path alphabet, swapped back to a
  // literal "$" at the end — keeps the $$-escape and the ${VAR}/$VAR
  // substitution below from interfering with each other.
  const DOLLAR_PLACEHOLDER = "\u0000"
  const withEscapesHidden = value.replaceAll("$$", DOLLAR_PLACEHOLDER)
  const expanded = withEscapesHidden.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_match, braced: string | undefined, bare: string | undefined) => {
      const ref = braced ?? bare!
      if (!isExpandablePathKey(ref)) {
        throw new UserError(
          `invalid ${key} "${value}": references "${ref}", which isn't a PATH_*/*_PATH ` +
            `server key — refusing to expand it.`,
        )
      }
      const resolvedRef = env[ref]
      if (resolvedRef === undefined) {
        throw new UserError(`invalid ${key} "${value}": references undefined variable "${ref}".`)
      }
      return resolvedRef
    },
  )
  return expanded.replaceAll(DOLLAR_PLACEHOLDER, "$")
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
  // reject an SSH_ADDRESS that could be read as an option, a
  // PATH_APPS/VOLUMES_PATH that isn't a plain absolute path rostok owns
  // entirely, and an SSH_USER that isn't a safe username — checked
  // regardless of what form SSH_ADDRESS takes (a bare ssh_config alias
  // has no user@ part for parseSshAddress to validate on its own, so
  // this is the only check SSH_USER gets; a hook can build an unquoted
  // remote shell command from it, e.g. syncthing's
  // `chown ${user}:${user} <path>`).
  validateSshAddress(resolved.SSH_ADDRESS)
  validateRemotePath("PATH_APPS", resolved.PATH_APPS)
  validateRemotePath("VOLUMES_PATH", resolved.VOLUMES_PATH, 1)
  validateSshUser(resolved.SSH_USER)

  // Normalised ONCE, right after validation, so every later consumer
  // (this function's own nesting check below, run-deploy.ts's rsync/
  // cleanup scripts, the remote readlink -f guard) works from the exact
  // same string — a trailing slash or doubled slash surviving through
  // only SOME of those would make two spellings of the same path look
  // different to a check that compares them as strings.
  resolved.PATH_APPS = normalizeRemotePath(resolved.PATH_APPS)
  resolved.VOLUMES_PATH = normalizeRemotePath(resolved.VOLUMES_PATH)

  // #233: a full deploy now syncs PATH_APPS with `rsync --delete`, so app
  // data must never live inside it — VOLUMES_PATH has to be a sibling
  // directory (e.g. /srv/apps and /srv/volumes), never nested either way
  // and never the same directory. Checked after expansion/normalisation
  // above, component-wise (pathsNestedOrEqual), so this also catches the
  // owner's own cloud server shape, VOLUMES_PATH=${PATH_APPS}/.volumes,
  // once it's expanded to a real nested path. This is the CLIENT-SIDE
  // check, against the strings in `.env`; run-deploy.ts also runs a
  // remote `readlink -f` guard before any deletion, since a symlink on
  // the server itself can defeat a string-only comparison.
  if (pathsNestedOrEqual(resolved.PATH_APPS, resolved.VOLUMES_PATH)) {
    throw new UserError(buildNestedPathsError(resolved.PATH_APPS, resolved.VOLUMES_PATH, envPath))
  }

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
