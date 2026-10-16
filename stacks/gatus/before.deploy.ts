// before.deploy.ts for gatus — overwrites the shipped starter config
// (stacks/gatus/config.yml, mounted at /config/config.yaml) with a
// server-specific one, when the operator wrote
// servers/<server>/configs/gatus.yml. Leaves the shipped starter (zero
// endpoints) in place otherwise, so `stack add gatus -n` plus deploy
// gives a container that starts with no manual config step.
//
// #397: when the staged config.yml holds the same bytes as the server's, it
// gets the server file's mtime, so rsync skips it, the server file keeps its
// inode, and after.deploy.ts does not restart hl-gatus. A server file that is
// missing or cannot be read leaves the staged file as it is: rsync copies it
// and after.deploy.ts restarts, as before.
//
// Self-contained per the deploy hook contract: no import out of this
// stack directory.

const OVERRIDE_PATH = "configs/gatus.yml"
const TARGET_PATH = "stacks/gatus/config.yml"

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

async function main(): Promise<void> {
  try {
    await Deno.copyFile(OVERRIDE_PATH, TARGET_PATH)
    console.log(`Copied ${OVERRIDE_PATH} → ${TARGET_PATH}`)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.log(
        `No server-specific Gatus config (${OVERRIDE_PATH} not found) — using shipped default`,
      )
    } else {
      throw err
    }
  }
  const env = (key: string) => Deno.env.get(key) || undefined
  const pathApps = env("PATH_APPS")
  if (pathApps === undefined) return
  const server = await readServerFile(
    env("SSH_HOST"),
    env("SSH_PORT"),
    env("SSH_USER"),
    `${pathApps}/${TARGET_PATH}`,
  )
  if (await keepServerMtime(TARGET_PATH, server)) {
    console.log(`${TARGET_PATH} unchanged, kept the server's copy`)
  }
}

if (import.meta.main) {
  await main()
}
