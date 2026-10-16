// Copies server-specific Traefik dynamic config files into the dynamic/
// directory before deployment. This is how a server adds its own routers,
// services and middlewares (a login middleware, a route to a service that
// is not a stack, a CORS rule for one of its hosts) next to the shared base
// config (00-base.yml) every server gets, without the catalog knowing them.
//
// Also generates .htpasswd for dashboard-auth by bcrypt-hashing
// TRAEFIK_BASIC_AUTH_PASSWORD. Uses `npm:bcryptjs` instead of the
// `htpasswd` binary so the hook needs nothing on the user's machine beyond
// Deno itself — the hook contract runs this file standalone (see
// stacks/traefik/README.md and docs/design/v1-cli.md), no relative import
// out of this stack directory.
//
// dynamic/00-base.yml points dashboard-auth at .htpasswd unconditionally,
// so a missing credential fails the deploy (exit 1) instead of logging
// and continuing — a green deploy with no .htpasswd would ship a
// dashboard nothing can log into.
//
// Traefik's basicAuth middleware caches the file at startup — the
// after.deploy.ts hook restarts hl-traefik after deploy so it picks up
// the new file.
//
// #397: a deploy that changes nothing must not restart Traefik. bcrypt salts
// every hash, so the hook first reads the server's current .htpasswd and keeps
// it when its hash still matches the password. When the staged file is then
// byte-identical, it also gets the server file's mtime: rsync skips a file
// whose size and mtime match, so the server file is not rewritten and
// after.deploy.ts sees it older than the running container.
//
// Paths are relative to the deploy staging folder, the hook's working directory:
//   configs/traefik/dynamic/*.yml  →  stacks/traefik/dynamic/*.yml
// (`configs/` is the project's `servers/<server>/configs/`.)

import { compareSync, hashSync } from "npm:bcryptjs@3.0.3"

const DYNAMIC_DIR = "stacks/traefik/dynamic"
const HTPASSWD_PATH = `${DYNAMIC_DIR}/.htpasswd`
const CONFIG_SOURCE = "configs/traefik/dynamic"

/**
 * bcrypt-hash `password`. Cost 10 matches `htpasswd -B`'s default and is
 * what this replaces. Exported so it's testable against bcryptjs's own
 * `compareSync` without running the hook.
 */
export function hashPassword(password: string): string {
  return hashSync(password, 10)
}

export interface HtpasswdCredential {
  user: string
  /** A bcrypt hash — already hashed by the caller, written verbatim. */
  hash: string
}

/**
 * The bcrypt hash in `existing` (a .htpasswd file's content) when it is a
 * single `<user>:<hash>` line for `user` and the hash matches `password`;
 * undefined otherwise, so the caller hashes afresh.
 */
function matchingHash(existing: string, user: string, password: string): string | undefined {
  const match = /^([^:\n]+):(\$2[aby]\$\d\d\$[./A-Za-z0-9]{53})\n$/.exec(existing)
  if (!match || match[1] !== user) return undefined
  return compareSync(password, match[2]) ? match[2] : undefined
}

/**
 * Resolve the .htpasswd entry to write, from TRAEFIK_BASIC_AUTH_USER +
 * TRAEFIK_BASIC_AUTH_PASSWORD. Pure — no I/O — so every branch is
 * testable without touching the filesystem.
 *
 * `existing` is the server's current .htpasswd, when it could be read. Its
 * hash is kept when it is for the same user and matches the password, so an
 * unchanged password gives a byte-identical file; a changed user or password
 * gets a new hash.
 *
 * Throws, naming exactly which key is missing, instead of returning
 * null: dynamic/00-base.yml points dashboard-auth at .htpasswd
 * unconditionally, so a deploy that skips writing it would go green
 * and still ship a dashboard nothing can log into.
 */
export function resolveHtpasswdCredential(
  getEnv: (key: string) => string | undefined,
  existing?: string,
): HtpasswdCredential {
  const user = getEnv("TRAEFIK_BASIC_AUTH_USER")
  const password = getEnv("TRAEFIK_BASIC_AUTH_PASSWORD")

  if (user && password) {
    const kept = existing === undefined ? undefined : matchingHash(existing, user, password)
    return { user, hash: kept ?? hashPassword(password) }
  }
  if (user && !password) {
    throw new Error(
      "TRAEFIK_BASIC_AUTH_USER is set but TRAEFIK_BASIC_AUTH_PASSWORD is not — both are required.",
    )
  }
  if (!user && password) {
    throw new Error(
      "TRAEFIK_BASIC_AUTH_PASSWORD is set but TRAEFIK_BASIC_AUTH_USER is not — both are required.",
    )
  }

  throw new Error(
    "No basic-auth credentials set: TRAEFIK_BASIC_AUTH_USER/TRAEFIK_BASIC_AUTH_PASSWORD are unset.",
  )
}

/** A file on the deploy target: its content, and its mtime in seconds when `stat` gave one. */
export interface ServerFile {
  content: string
  mtime?: number
}

/** `[user@]host` — no brackets: ssh gets host and -p <port> as separate argv slots. */
function targetHost(host: string, user: string | undefined): string {
  return user ? `${user}@${host}` : host
}

/** Digits only, 1-65535 — the same range cli/server-keys.ts's parseSshAddress enforces. */
function isValidPort(port: string): boolean {
  if (!/^\d+$/.test(port)) return false
  const n = Number(port)
  return n >= 1 && n <= 65535
}

/** Single-quote `value` for a POSIX shell. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * The argv of `ssh [-p <port>] -o ConnectTimeout=10 -o BatchMode=yes --
 * [user@]host <script>`, where the script prints `path`'s mtime (seconds, with
 * the fraction, or an empty line when `stat` cannot give it) and then its
 * content, and exits non-zero when the file cannot be read. The same options
 * as after.deploy.ts's restart. Throws on a bad `port`. Exported for tests —
 * no I/O.
 */
export function buildReadCommand(
  host: string,
  port: string | undefined,
  user: string | undefined,
  path: string,
): string[] {
  if (port !== undefined && !isValidPort(port)) {
    throw new Error(`invalid SSH_PORT "${port}": expected digits 1-65535`)
  }
  const quoted = shQuote(path)
  return [
    ...(port !== undefined ? ["-p", port] : []),
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "--",
    targetHost(host, user),
    `stat -c %.9Y -- ${quoted} 2>/dev/null || echo; cat -- ${quoted}`,
  ]
}

/** buildReadCommand's output split into the file's mtime and content. Exported for tests. */
export function parseReadOutput(output: string): ServerFile {
  const newline = output.indexOf("\n")
  const first = newline === -1 ? output : output.slice(0, newline)
  const mtime = /^\d+(\.\d+)?$/.test(first) ? Number(first) : undefined
  return { content: newline === -1 ? "" : output.slice(newline + 1), mtime }
}

/**
 * The deploy target's copy of `path`: read directly on a local server (no
 * `host`), over ssh otherwise. Undefined when it is missing or cannot be
 * read, including a failed ssh: the hook then behaves as before #397 and
 * writes a fresh file.
 */
export async function readServerFile(
  host: string | undefined,
  port: string | undefined,
  user: string | undefined,
  path: string,
): Promise<ServerFile | undefined> {
  try {
    if (!host) {
      const info = await Deno.stat(path)
      const content = await Deno.readTextFile(path)
      return { content, mtime: info.mtime ? info.mtime.getTime() / 1000 : undefined }
    }
    const out = await new Deno.Command("ssh", {
      args: buildReadCommand(host, port, user, path),
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output()
    return out.success ? parseReadOutput(new TextDecoder().decode(out.stdout)) : undefined
  } catch {
    return undefined
  }
}

/**
 * Give the staged file at `path` the server file's mtime when both hold the
 * same bytes, so rsync's size-and-mtime check skips it and the server file
 * keeps its inode and change time. Returns whether it did.
 */
export async function keepServerMtime(
  path: string,
  server: ServerFile | undefined,
): Promise<boolean> {
  if (server?.mtime === undefined) return false
  if ((await Deno.readTextFile(path)) !== server.content) return false
  await Deno.utime(path, server.mtime, server.mtime)
  return true
}

async function writeHtpasswd(user: string, hash: string): Promise<void> {
  // 0644, not 0600: the file holds a bcrypt hash, not the password
  // itself, and Traefik on the server runs as PUID:PGID — an owner
  // decided by the local uid that rsync'd the file, not necessarily
  // PUID. 0600 would leave the running container unable to read its
  // own dashboard-auth file.
  await Deno.writeTextFile(HTPASSWD_PATH, `${user}:${hash}\n`, { mode: 0o644 })
}

async function generateHtpasswd(): Promise<void> {
  const env = (key: string) => Deno.env.get(key) || undefined
  const pathApps = env("PATH_APPS")
  const server = pathApps === undefined ? undefined : await readServerFile(
    env("SSH_HOST"),
    env("SSH_PORT"),
    env("SSH_USER"),
    `${pathApps}/${HTPASSWD_PATH}`,
  )
  const credential = resolveHtpasswdCredential(env, server?.content)
  await writeHtpasswd(credential.user, credential.hash)
  if (await keepServerMtime(HTPASSWD_PATH, server)) {
    console.log(`${HTPASSWD_PATH} unchanged, kept the server's copy`)
  } else {
    console.log(`Generated ${HTPASSWD_PATH}`)
  }
}

/** Whether a file name is a Traefik dynamic config the file provider loads. */
export function isDynamicConfigName(name: string): boolean {
  return name.endsWith(".yml") || name.endsWith(".yaml")
}

/**
 * Copy every `.yml`/`.yaml` file of `source` (the server's own `configs/traefik/dynamic/`) into
 * `dest`, next to the catalog's `00-base.yml`, and return the copied names, sorted. This is how a
 * server adds routers, services and middlewares the catalog does not know about. A missing
 * `source` returns an empty list. A server file with the name of a catalog file replaces it.
 */
export async function copyServerConfigs(source: string, dest: string): Promise<string[]> {
  let entries: Deno.DirEntry[]
  try {
    entries = await Array.fromAsync(Deno.readDir(source))
  } catch (err) {
    // Only a missing source is fine; a missing destination must fail the deploy below.
    if (err instanceof Deno.errors.NotFound) return []
    throw err
  }
  const copied: string[] = []
  for (const entry of entries) {
    // Plain files only: a symlink could point outside the server's folder.
    if (!entry.isFile || entry.isSymlink || !isDynamicConfigName(entry.name)) continue
    await Deno.copyFile(`${source}/${entry.name}`, `${dest}/${entry.name}`)
    copied.push(entry.name)
  }
  return copied.sort()
}

if (import.meta.main) {
  try {
    const copied = await copyServerConfigs(CONFIG_SOURCE, DYNAMIC_DIR)
    if (copied.length === 0) {
      console.log(`No server-specific Traefik configs in ${CONFIG_SOURCE}`)
    }
    for (const name of copied) {
      console.log(`Copied ${CONFIG_SOURCE}/${name} → ${DYNAMIC_DIR}/${name}`)
    }
    await generateHtpasswd()
  } catch (err) {
    console.error("before.deploy.ts FAILED:", err instanceof Error ? err.message : String(err))
    Deno.exit(1)
  }
}
