// Names shared by `server create`, `stack add`, `deploy` and the catalog.
//
// Every server keeps one `servers/<name>/.env`. Its keys fall in two groups:
//
// - Server-level keys, written by `server create` and read by any stack:
//   the list below plus every `PATH_*` key (shared host paths such as
//   PATH_MEDIA, which jellyfin and filebrowser both mount).
// - Stack-owned keys, declared by one stack's `+meta.ts` and prefixed with
//   that stack's name in SCREAMING_SNAKE_CASE (`LIBRESPEED_IMAGE_TAG`,
//   `DEEPSEEK_HARNESS_VERSION`). Two stacks never declare the same
//   stack-owned key.

import { join, resolve, SEPARATOR } from "@std/path"
import { UserError } from "./errors.ts"

/**
 * Server-level keys, in the order `server create` writes them.
 *
 * SERVER_NAME was previously injected only in memory during `stack add`'s
 * variable resolution (for `${SERVER_NAME}` string defaults), never
 * written to `.env` — a `compose.yml` that read it directly at deploy
 * time (e.g. zond's `probe-${SERVER_NAME}.${DOMAIN}` host rule) had
 * nothing to read. It's a genuine per-server fact — the directory name —
 * so it's added here and to the keys `server create` writes below,
 * fixing that gap.
 */
export const SERVER_KEYS = [
  "PROJECT",
  "SSH_ADDRESS",
  // SSH_HOST/SSH_PORT: not written to .env — cli/deploy/hooks.ts's
  // buildHookEnv derives them from SSH_ADDRESS (via parseSshAddress) on
  // every hook run, the same way it already does for
  // SSH_ADDRESS/SSH_USER/PATH_APPS/DEPLOY_AS (#229). SSH_HOST is always
  // set; SSH_PORT only when SSH_ADDRESS carries an explicit port (never
  // a default — see buildHookEnv's own module comment for why). Listed
  // here so a hook reading them passes cli/catalog.test.ts's "every
  // host-env key is a server key or carries the stack's own prefix"
  // check.
  "SSH_HOST",
  "SSH_PORT",
  "SSH_USER",
  "SERVER_NAME",
  "DOMAIN",
  "CONTACT_EMAIL",
  "DOCKER_GROUP_ID",
  "TIMEZONE",
  "PUID",
  "PGID",
  "VOLUMES_PATH",
  "PATH_APPS",
] as const

/** Keys `rostok deploy` cannot run without. `server create` must write all of them. */
export const DEPLOY_REQUIRED_KEYS = [
  "SSH_ADDRESS",
  "SSH_USER",
  "PATH_APPS",
  "VOLUMES_PATH",
  "PUID",
  "PGID",
  "DOCKER_GROUP_ID",
] as const

/** Where stacks live on the server when the user accepts the default. */
export const DEFAULT_PATH_APPS = "/srv/apps"

/** True for a server-level key: one of SERVER_KEYS or any `PATH_*` key. */
export function isServerKey(key: string): boolean {
  return (SERVER_KEYS as readonly string[]).includes(key) || /^PATH_[A-Z0-9_]+$/.test(key)
}

/** The prefix every stack-owned key of `stackName` must start with: `deepseek-harness` → `DEEPSEEK_HARNESS_`. */
export function stackKeyPrefix(stackName: string): string {
  return `${stackName.toUpperCase().replace(/-/g, "_")}_`
}

/**
 * Prefixes no stack's own `stackKeyPrefix` may start with. A stack
 * named e.g. "git" or "docker" would get prefix "GIT_"/"DOCKER_",
 * letting its own `.env`-sourced keys collide with names tools like
 * git, ssh, bash, sudo, curl, aws, ansible, systemd etc. treat
 * specially wherever a hook's environment (or anything else reading a
 * `<PREFIX>_*` key) forwards them — regardless of the separate
 * deny-list `cli/deploy/hooks.ts` applies at hook-run time. Checked by
 * `validateStackConfigs` before a stack of that name can be deployed.
 */
export const RESERVED_STACK_KEY_PREFIXES = [
  "LD_",
  "DYLD_",
  "DENO_",
  "NPM_",
  "NODE_",
  "PYTHON",
  "PERL",
  "GIT_",
  "DOCKER_",
  "SSH_",
  "BASH_",
  "SUDO_",
  "OPENSSL_",
  "SSL_",
  "CURL_",
  "JAVA_",
  "JDK_",
  "XDG_",
  "RSYNC_",
  "HTTP_",
  "HTTPS_",
  "ALL_",
  "NO_",
  "PIP_",
  "AWS_",
  "CARGO_",
  "DBUS_",
  "SYSTEMD_",
  "ANSIBLE_",
  "LC_",
  "GPG_",
  "TMUX_",
  // Deno reads JSR_URL to pick the registry a hook's `jsr:` imports come from.
  "JSR_",
  "RUST_",
] as const

/**
 * Catalog stacks that shipped before RESERVED_STACK_KEY_PREFIXES
 * existed, whose name happens to start with a now-reserved prefix
 * ("docker-registry", "docker-sock-proxy" → "DOCKER_"). Exempted so
 * this rule doesn't retroactively refuse to deploy something already
 * in production — a NEW stack can't add itself here; it has to pick a
 * name whose prefix isn't reserved. Revisit by renaming these two
 * stacks in a separate PR (a breaking change for anyone who already
 * deployed them) rather than by growing this list.
 */
export const RESERVED_STACK_KEY_PREFIX_EXEMPTIONS = [
  "docker-registry",
  "docker-sock-proxy",
] as const

/** True when `stackName`'s own key prefix starts with a reserved prefix (see RESERVED_STACK_KEY_PREFIXES), unless exempted. */
export function hasReservedStackKeyPrefix(stackName: string): boolean {
  if ((RESERVED_STACK_KEY_PREFIX_EXEMPTIONS as readonly string[]).includes(stackName)) return false
  const prefix = stackKeyPrefix(stackName)
  return RESERVED_STACK_KEY_PREFIXES.some((reserved) => prefix.startsWith(reserved))
}

/** Lowercase letters, digits and dashes; starts with a letter or digit; at most 63 characters. */
export const SERVER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * Throw a UserError unless `name` is a valid server name. The name becomes
 * a folder under `servers/`, a remote path segment and part of shell
 * commands, so anything outside SERVER_NAME_PATTERN is refused.
 */
export function validateServerName(name: string): void {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new UserError(
      `invalid server name "${name}": use lowercase letters, digits and dashes, ` +
        `start with a letter or digit, at most 63 characters (e.g. "home", "cloud-1").`,
    )
  }
}

/**
 * Validate `name` and return `<cwd>/servers/<name>`. Checks again after
 * joining that the path stays inside `<cwd>/servers/`, so a future change
 * to the pattern can't reopen path traversal.
 */
export function serverDirFor(cwd: string, name: string): string {
  validateServerName(name)
  const root = resolve(cwd, "servers")
  const dir = resolve(join(root, name))
  if (!dir.startsWith(root + SEPARATOR)) {
    throw new UserError(`server "${name}" resolves outside ${root}`)
  }
  return dir
}

/** A parsed `SSH_ADDRESS`: an optional user, the host (or ssh_config alias), and an optional port. */
export interface SshTarget {
  user?: string
  host: string
  port?: number
}

/** Strip ASCII control characters (including DEL) before echoing untrusted input (a key name, a rejected value) into a log line or error message. */
function sanitizeForLog(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, "")
}

function sshAddressError(value: string): UserError {
  return new UserError(
    `invalid SSH_ADDRESS "${sanitizeForLog(value)}": use an ssh_config alias, a host, user@host, ` +
      `host:port, user@host:port, an IPv6 address, or [IPv6]:port, with no spaces and not ` +
      `starting with "-".`,
  )
}

/** Letters, digits, `.`, `_`, `-` and `:` (bare IPv6 needs the colons) — nothing a shell reads specially. */
const SSH_HOST_CHARS_PATTERN = /^[A-Za-z0-9_.:-]+$/

/** Hex digits and colons only — the alphabet an IPv6 literal's groups use, nothing else. */
const HEX_COLON_PATTERN = /^[0-9a-fA-F:]+$/

/**
 * Letters, digits, `.`, `_` and `-`, starting with a letter/digit/`_` —
 * an ssh/system username. Excludes `:` (so `root:x@host` can't smuggle
 * a second field into the user position), `$`/backtick/quotes (shell
 * metacharacters) and whitespace/newlines. Exported so `SSH_USER` (a
 * separate `.env` key, not always embedded in `SSH_ADDRESS` — a bare
 * ssh_config alias never carries a user at all) gets the same check
 * `parseSshAddress` already applies to an address's own `user@` part.
 */
export const SSH_USER_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

/**
 * Throw a UserError unless `value` is a safe ssh/system username — see
 * SSH_USER_PATTERN. `SSH_USER` reaches a hook's environment and, from
 * there, an unquoted remote shell command a hook builds by hand (e.g.
 * syncthing's `chown ${user}:${user} <path>` — reviewed and confirmed
 * unquoted): a value like `"x $HOME"` or `"x; rm -rf /"` would run as
 * part of that command on the remote host. Checked regardless of what
 * form `SSH_ADDRESS` takes — a bare ssh_config alias has no `user@`
 * part for `parseSshAddress` to validate at all, so this is the only
 * check `SSH_USER` gets.
 */
export function validateSshUser(value: string): void {
  if (!SSH_USER_PATTERN.test(value)) {
    throw new UserError(
      `invalid SSH_USER "${value}": use letters, digits, ".", "_" and "-", starting with a ` +
        `letter, digit or "_" — an ssh/system username, no spaces or shell metacharacters.`,
    )
  }
}

/**
 * Parse `SSH_ADDRESS` into `{ user?, host, port? }`. Throws a UserError for
 * anything unsafe to hand to `ssh`/`rsync` as a target, or genuinely
 * ambiguous:
 *
 * - A leading `-` on the whole value, or on the host part once a user
 *   is split off (`root@-A`, `user@-oProxyCommand`) — either would be
 *   read as an ssh option the moment ssh's own option parser saw it
 *   (see runRemoteCommand's `--` for the second, independent guard).
 * - A user containing anything outside SSH_USER_PATTERN — a space,
 *   `$(...)`/backticks, a quote, or a `:` (`root:x@host`).
 * - An empty address, an empty user (`@host`) or an empty host (`user@`,
 *   `:2222`).
 * - A newline anywhere — rejected by SSH_USER_PATTERN/SSH_HOST_CHARS_PATTERN,
 *   neither of which includes it.
 * - A port outside 1–65535, or a non-numeric port.
 * - An unbracketed IPv6 address followed by what looks like a port
 *   (contains `::` and the text after the last `:` is all digits) — ssh
 *   itself has no way to tell a trailing port from a hex segment there,
 *   so this is refused rather than guessed at; bracket it instead
 *   (`[2001:db8::1]:2222`).
 *
 * A bare multi-colon address with no `::` (a rare fully-written IPv6
 * literal) or one that doesn't end in a plausible port is accepted as a
 * host with no port — ssh accepts it unbracketed as long as there's no
 * port to disambiguate.
 */
export function parseSshAddress(value: string): SshTarget {
  if (value.startsWith("-")) throw sshAddressError(value)

  let rest = value
  let user: string | undefined
  const atIdx = rest.indexOf("@")
  if (atIdx !== -1) {
    user = rest.slice(0, atIdx)
    rest = rest.slice(atIdx + 1)
    if (user === "" || !SSH_USER_PATTERN.test(user)) throw sshAddressError(value)
  }
  if (rest === "") throw sshAddressError(value)
  if (rest.startsWith("-")) throw sshAddressError(value)

  let host: string
  let portText: string | undefined

  if (rest.startsWith("[")) {
    const closeIdx = rest.indexOf("]")
    if (closeIdx === -1) throw sshAddressError(value)
    host = rest.slice(1, closeIdx)
    const after = rest.slice(closeIdx + 1)
    if (after !== "") {
      if (!after.startsWith(":")) throw sshAddressError(value)
      portText = after.slice(1)
    }
    if (host === "") throw sshAddressError(value)
  } else {
    const colonCount = rest.split(":").length - 1
    if (colonCount === 0) {
      host = rest
    } else if (colonCount === 1) {
      const idx = rest.indexOf(":")
      host = rest.slice(0, idx)
      portText = rest.slice(idx + 1)
      if (host === "") throw sshAddressError(value)
    } else {
      // 2+ colons — either a genuine, unbracketed IPv6 literal, or
      // something ambiguous that ssh (and getaddrinfo) can't reliably
      // read as one or the other, refused rather than guessed at.
      if (rest.includes("::")) {
        // Abbreviated form. If, after splitting off whatever sits after
        // the LAST colon, everything before it still contains "::" AND
        // that last segment is all digits, the whole thing reads
        // equally well as "abbreviated IPv6" or "IPv6 with a trailing
        // port" — ssh can't tell, so it's refused; bracket it instead
        // (e.g. "2001:db8::1:2222"). Otherwise (the "::" pair sits right
        // at the split point, e.g. "2001:db8::1", or the last segment
        // isn't numeric) it's accepted whole, as a bare IPv6 host.
        const lastColon = rest.lastIndexOf(":")
        const maybeHost = rest.slice(0, lastColon)
        const maybePort = rest.slice(lastColon + 1)
        if (/^\d+$/.test(maybePort) && maybeHost.includes("::")) {
          throw new UserError(
            `invalid SSH_ADDRESS "${sanitizeForLog(value)}": bracket an IPv6 address that ` +
              `carries a port — use "[${sanitizeForLog(maybeHost)}]:${sanitizeForLog(maybePort)}".`,
          )
        }
        if (!HEX_COLON_PATTERN.test(rest)) throw sshAddressError(value)
        host = rest
      } else {
        // No "::" at all — only a REAL, full IPv6 literal (exactly 8
        // colon-separated groups, each 1-4 hex digits) is accepted as a
        // bare host; anything else with 2+ colons is refused outright,
        // whether or not it merely LOOKS hex ("cafe:22:33",
        // "deadbeef:22:33" — every character is a valid hex digit, but
        // 3 groups isn't a real IPv6 shape) or doesn't ("host:22:33",
        // #236). A real 8-group literal can legitimately end in an
        // all-digit group (see the accepted-cases test table), so no
        // separate host/port split is needed for this branch.
        const groups = rest.split(":")
        const isFullIpv6 = groups.length === 8 &&
          groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))
        if (!isFullIpv6) {
          throw new UserError(
            `invalid SSH_ADDRESS "${sanitizeForLog(value)}": "${
              sanitizeForLog(rest)
            }" has more than one colon and isn't a recognizable IPv6 address — ssh can't tell ` +
              `a host from a port here. Use a single "host:port", or configure the port on an ` +
              `ssh_config alias instead.`,
          )
        }
        host = rest
      }
    }
  }

  if (!SSH_HOST_CHARS_PATTERN.test(host)) throw sshAddressError(value)

  let port: number | undefined
  if (portText !== undefined) {
    if (!/^\d+$/.test(portText)) throw sshAddressError(value)
    port = Number(portText)
    if (port < 1 || port > 65535) {
      throw new UserError(
        `invalid SSH_ADDRESS "${sanitizeForLog(value)}": port ${port} is outside 1-65535.`,
      )
    }
  }

  return { user, host, port }
}

/** Throw a UserError unless `value` parses as a valid SSH_ADDRESS — see `parseSshAddress`. */
export function validateSshAddress(value: string): void {
  parseSshAddress(value)
}

/**
 * `user@host`, or just `host`/the ssh_config alias with no user. Never
 * brackets an IPv6 host: ssh gets the target and `-p <port>` as separate
 * argv slots (sshArgs below), so there's no single "host:port" string
 * for a bare colon to be ambiguous inside — brackets are only needed
 * where the two are joined into one string (rsyncDestination below).
 */
function targetHost(target: SshTarget): string {
  return target.user ? `${target.user}@${target.host}` : target.host
}

/** Extra options every ssh call deploy makes gets — see #219 (module comment in exec.ts). */
export interface SshCallOptions {
  /** `-o BatchMode=yes` — set when stdin isn't a TTY, so ssh fails fast instead of prompting. */
  batchMode?: boolean
}

/**
 * The argv for `ssh` given a parsed target: the standard options
 * (`ConnectTimeout=10`, `BatchMode=yes` when `opts.batchMode`), `-p
 * <port>` when set, `--` (stops ssh's own option parser from ever
 * reading the target as a flag — defense in depth even though
 * `parseSshAddress` already rejects a leading `-`), then `user@host`,
 * then any extra argv.
 */
export function sshArgs(
  target: SshTarget,
  extra: string[] = [],
  opts: SshCallOptions = {},
): string[] {
  const args: string[] = ["-o", "ConnectTimeout=10"]
  if (opts.batchMode) args.push("-o", "BatchMode=yes")
  if (target.port !== undefined) args.push("-p", String(target.port))
  args.push("--", targetHost(target))
  return [...args, ...extra]
}

/** rsync's `-e "ssh ..."` value for a parsed target — same options as `sshArgs`, minus the target/`--`. */
export function rsyncSshOption(target: SshTarget, opts: SshCallOptions = {}): string {
  const parts = ["ssh", "-o", "ConnectTimeout=10"]
  if (opts.batchMode) parts.push("-o", "BatchMode=yes")
  if (target.port !== undefined) parts.push("-p", String(target.port))
  return parts.join(" ")
}

/**
 * `user@host:<remotePath>` — rsync's destination argument, as one
 * string. Unlike `sshArgs`, a bare IPv6 host here always needs brackets
 * (`[2001:db8::1]:/path`, port or not): rsync itself splits this string
 * on the first `:` to separate host from path, so an unbracketed IPv6
 * address's own colons would be read as that separator.
 */
export function rsyncDestination(target: SshTarget, remotePath: string): string {
  const host = target.host.includes(":") ? `[${target.host}]` : target.host
  const withUser = target.user ? `${target.user}@${host}` : host
  return `${withUser}:${remotePath}`
}

/** Absolute path made of letters, digits, `.`, `_`, `-` and `/`. */
export const REMOTE_PATH_PATTERN = /^\/[A-Za-z0-9._/-]*$/

/**
 * Throw a UserError unless `value` is a plain absolute path with at
 * least two components (`/srv/apps`, never `/` or `/srv`). Remote paths
 * such as PATH_APPS and VOLUMES_PATH reach the server's login shell
 * through rsync, so shell metacharacters and `..` segments are refused.
 *
 * The two-component floor (#233 review) is a "rostok owns this
 * directory entirely" guard: `PATH_APPS=/` or `PATH_APPS=/home` would
 * make a full deploy's `rsync --delete` (run-deploy.ts) delete
 * everything else already on the server under that path — `/srv` is
 * shallow enough that a typo or a copy-pasted default (`/home` instead
 * of `/home/deploy/apps`) is a real risk, not a hypothetical one.
 */
export function validateRemotePath(key: string, value: string): void {
  if (!REMOTE_PATH_PATTERN.test(value) || value.split("/").includes("..")) {
    throw new UserError(
      `invalid ${key} "${value}": use an absolute path of letters, digits, ".", "_", "-" ` +
        `and "/", e.g. /srv/apps.`,
    )
  }
  if (pathComponents(value).length < 2) {
    throw new UserError(
      `invalid ${key} "${value}": must be a directory rostok owns entirely, at least two path ` +
        `components deep (e.g. /srv/apps, not /srv or /) — a deploy deletes stale files under ` +
        `it and must never reach anything else already on the server.`,
    )
  }
}

/** `path`, split into its non-empty, non-"." components — the same shape whether it has a trailing slash, a doubled slash, or a `./` segment. `validateRemotePath` already refuses a `..` segment before this runs. */
export function pathComponents(path: string): string[] {
  return path.split("/").filter((c) => c !== "" && c !== ".")
}

/**
 * Normalise `path` — collapse doubled slashes, drop a trailing slash
 * and `.` segments — into one canonical absolute-path string, so every
 * later comparison (`pathsNestedOrEqual`, an error message, a remote
 * shell command) works from the same value instead of re-deriving it
 * (and risking a different normalisation) each time. `validateRemotePath`
 * has already refused a `..` segment and confirmed `path` is absolute
 * before this is meant to run.
 */
export function normalizeRemotePath(path: string): string {
  return `/${pathComponents(path).join("/")}`
}

/**
 * True when `a` and `b` are the same directory, or one sits inside the
 * other — compared path-component-wise after normalising away trailing
 * slashes, doubled slashes and `.` segments, NEVER as a raw string
 * prefix. A raw-prefix check would wrongly flag `/srv/apps2` as inside
 * `/srv/apps` (#233): component-wise, `["srv","apps2"]` doesn't share a
 * full first-two-components match with `["srv","apps"]`. Equal paths
 * count as nested — `deploy` treats `VOLUMES_PATH == PATH_APPS` the same
 * as one containing the other, since either way a `PATH_APPS` sync with
 * `--delete` would delete the volumes.
 */
export function pathsNestedOrEqual(a: string, b: string): boolean {
  const ca = pathComponents(a)
  const cb = pathComponents(b)
  const [shorter, longer] = ca.length <= cb.length ? [ca, cb] : [cb, ca]
  return shorter.every((component, i) => component === longer[i])
}
