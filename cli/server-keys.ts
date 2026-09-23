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

/** Server-level keys, in the order `server create` writes them. */
export const SERVER_KEYS = [
  "PROJECT",
  "SSH_ADDRESS",
  "SSH_USER",
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

/** An ssh_config alias, host, `user@host` or IPv6 address; never starts with `-`. */
export const SSH_ADDRESS_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._@:-]*$/

/**
 * Throw a UserError unless `value` is safe to pass to `ssh` and `rsync` as
 * the target: an ssh_config alias, `host` or `user@host`. A leading `-`
 * would be read as an ssh option (`-oProxyCommand=…` runs a local
 * command), and rsync re-spawns ssh with the target itself, so `--` alone
 * can't protect it. Only letters, digits and `._-@:` are allowed.
 */
export function validateSshAddress(value: string): void {
  if (!SSH_ADDRESS_PATTERN.test(value)) {
    throw new UserError(
      `invalid SSH_ADDRESS "${value}": use an ssh_config alias, a host or user@host, ` +
        `with no spaces and not starting with "-".`,
    )
  }
}

/** Absolute path made of letters, digits, `.`, `_`, `-` and `/`. */
export const REMOTE_PATH_PATTERN = /^\/[A-Za-z0-9._/-]*$/

/**
 * Throw a UserError unless `value` is a plain absolute path. Remote paths
 * such as PATH_APPS and VOLUMES_PATH reach the server's login shell through
 * rsync, so shell metacharacters and `..` segments are refused.
 */
export function validateRemotePath(key: string, value: string): void {
  if (!REMOTE_PATH_PATTERN.test(value) || value.split("/").includes("..")) {
    throw new UserError(
      `invalid ${key} "${value}": use an absolute path of letters, digits, ".", "_", "-" ` +
        `and "/", e.g. /srv/apps.`,
    )
  }
}
