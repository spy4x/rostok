// before.deploy.ts — stops a deploy that would start Postgres 18 next to data it cannot read
// (#363). Up to rostok 1.21, this stack kept Postgres 16 data in `${VOLUMES_PATH}/<stack>/db`.
// Postgres 18 uses `${VOLUMES_PATH}/<stack>/postgres` instead and would start there with an
// empty database, so the app would look empty. This hook fails the deploy and names the step
// that fixes it while the old folder exists and the new one holds no data, while an upgrade
// that did not finish left its marker, and while `<STACK>_DB_IMAGE_TAG` names Postgres 17 or
// older (that image would make a second, empty cluster in the new folder).
//
// The same file is in stacks/gitea, stacks/umami and stacks/caldiy (gitea's test checks the
// copies are equal): the hook contract allows no import out of the stack's own folder, so the
// stack name comes from this file's own URL.

const UPGRADE_DOC = "https://github.com/spy4x/rostok/blob/main/docs/usage/postgres-upgrade.md"

/** Exit code of the check script when the deploy must stop. */
export const REFUSE = 3
/** Exit code of the check script when it cannot see into the stack folder. */
export const CANNOT_ENTER = 4
/** Exit code of the check script when an upgrade did not finish. */
export const INCOMPLETE = 5

/** The stack folder name in `.../stacks/<name>/before.deploy.ts`, a file or jsr.io URL. */
export function stackFromUrl(url: string): string {
  const match = url.match(/\/stacks\/([a-z0-9-]+)\/before\.deploy\.ts$/)
  if (!match) throw new Error(`cannot tell the stack from ${url}`)
  return match[1]
}

/** Single-quote `value` for a POSIX shell. */
function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * The check run with the deploy user's own rights, as `sh -c <it> sh <stack folder>`. It reads
 * only folder names, so a user who cannot open the Postgres-owned data folder gets the right
 * answer. It exits CANNOT_ENTER when the deepest existing folder on the path cannot be entered
 * (the stack folder would otherwise read as missing), INCOMPLETE on upgrade.sh's marker,
 * REFUSE when `db` exists and `postgres` holds no `<major>/docker` folder, and 0 otherwise.
 */
const CHECK = [
  `p=$1`,
  `while [ ! -e "$p" ]; do p=$(dirname -- "$p"); done`,
  `[ -d "$p" ] && [ -x "$p" ] || { echo "cannot enter $p" >&2; exit ${CANNOT_ENTER}; }`,
  `[ ! -e "$1/postgres/.upgrade-incomplete" ] || exit ${INCOMPLETE}`,
  `[ -d "$1/db" ] || exit 0`,
  `for d in "$1"/postgres/*/docker; do [ -d "$d" ] && exit 0; done`,
  `exit ${REFUSE}`,
].join("\n")

/**
 * A POSIX shell script that runs CHECK on `<volumes>/<stack>` and exits with its code. A deploy
 * user that is not root and cannot enter the folder repeats it through `sudo -n`, as
 * cli/deploy/volumes.ts does; when sudo fails too, the exit code is sudo's, never 0.
 */
export function buildCheckScript(volumesPath: string, stack: string): string {
  return [
    `check=${shQuote(CHECK)}`,
    `dir=${shQuote(`${volumesPath}/${stack}`)}`,
    `sh -c "$check" sh "$dir"; code=$?`,
    `if [ "$code" = ${CANNOT_ENTER} ] && [ "$(id -u)" != 0 ]; then`,
    `  sudo -n sh -c "$check" sh "$dir"; code=$?`,
    `fi`,
    `exit "$code"`,
  ].join("\n")
}

/** The upgrade command a message names; the script needs root. */
function upgradeCommand(volumesPath: string, stack: string): string {
  return `  sudo sh upgrade.sh ${volumesPath} ${stack}`
}

/** The message a refused deploy prints. */
export function refusal(volumesPath: string, stack: string): string {
  const dir = `${volumesPath}/${stack}`
  return [
    `${stack}: ${dir}/db holds data from Postgres 16 or older, and ${dir}/postgres holds none.`,
    `This version runs Postgres 18 in ${dir}/postgres and would start with an empty database.`,
    `Move the data first, on the server, while the old version still runs:`,
    upgradeCommand(volumesPath, stack),
    `Then deploy again. Steps and where to get upgrade.sh: ${UPGRADE_DOC}`,
  ].join("\n")
}

/** The message a deploy prints when upgrade.sh's marker is there. */
export function incomplete(volumesPath: string, stack: string): string {
  const dir = `${volumesPath}/${stack}`
  return [
    `${stack}: an upgrade to Postgres 18 did not finish: ${dir}/postgres/.upgrade-incomplete`,
    `exists, so ${dir}/postgres may hold only part of the data. Run the upgrade again on the`,
    `server; it says how to put the old data back first:`,
    upgradeCommand(volumesPath, stack),
    `Steps: ${UPGRADE_DOC}`,
  ].join("\n")
}

/** The env key of the stack's Postgres image tag, such as GITEA_DB_IMAGE_TAG. */
export function dbTagKey(stack: string): string {
  return `${stack.toUpperCase().replaceAll("-", "_")}_DB_IMAGE_TAG`
}

/**
 * The message when `tag` names Postgres 17 or older (`16`, `16.9`, `16-alpine`, a pinned
 * `16.9@sha256:...`), or undefined. A tag with no leading major, such as `latest`, passes.
 */
export function oldTagRefusal(stack: string, tag: string | undefined): string | undefined {
  const major = Number(tag?.match(/^(\d+)/)?.[1] ?? NaN)
  if (!(major < 18)) return undefined
  const key = dbTagKey(stack)
  return [
    `${stack}: ${key}=${tag} names Postgres ${major}. This version of the stack needs Postgres 18`,
    `or later: an older image would start a second, empty database in the new data folder.`,
    `Set ${key} to an 18 tag such as 18-alpine, or remove it to use the default.`,
    `If the stack already holds data, upgrade it first: ${UPGRADE_DOC}`,
  ].join("\n")
}

/** Digits only, 1-65535 — the same range cli/server-keys.ts's parseSshAddress enforces. */
function isValidPort(port: string): boolean {
  if (!/^\d+$/.test(port)) return false
  const n = Number(port)
  return n >= 1 && n <= 65535
}

/**
 * The program and argv that run `script` on the deploy target: `sh -c` on this machine when
 * `host` is unset (a local server), `ssh [-p <port>] -o ConnectTimeout=10 -o BatchMode=yes --
 * [user@]host <script>` otherwise. Throws on a bad `port`. Exported for tests — no I/O.
 */
export function buildCommand(
  host: string | undefined,
  port: string | undefined,
  user: string | undefined,
  script: string,
): { cmd: string; args: string[] } {
  if (!host) return { cmd: "sh", args: ["-c", script] }
  if (port !== undefined && !isValidPort(port)) {
    throw new Error(`invalid SSH_PORT "${port}": expected digits 1-65535`)
  }
  const target = user ? `${user}@${host}` : host
  const portArgs = port !== undefined ? ["-p", port] : []
  const args = [...portArgs, "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "--", target]
  return { cmd: "ssh", args: [...args, script] }
}

/**
 * The deploy target's ssh host, or undefined on a local server. The local path is taken only
 * when deploy says the server is local (SSH_LOCAL=true, cli/deploy/hooks.ts): a missing
 * SSH_HOST alone is an error, so a hook run by hand never checks this machine instead.
 */
export function deployTargetHost(env: (key: string) => string | undefined): string | undefined {
  const host = env("SSH_HOST") || undefined
  if (host !== undefined || env("SSH_LOCAL") === "true") return host
  throw new Error(
    "SSH_HOST is not set and SSH_LOCAL is not true: run this hook through rostok deploy",
  )
}

/** Runs the check on the deploy target; returns the message to fail with, or undefined. */
export async function check(
  env: (key: string) => string | undefined,
  stack: string,
): Promise<string | undefined> {
  const oldTag = oldTagRefusal(stack, env(dbTagKey(stack)))
  if (oldTag) return oldTag
  const volumesPath = env("VOLUMES_PATH")
  if (!volumesPath) return "VOLUMES_PATH is not set"
  const script = buildCheckScript(volumesPath, stack)
  const { cmd, args } = buildCommand(
    deployTargetHost(env),
    env("SSH_PORT"),
    env("SSH_USER"),
    script,
  )
  const out = await new Deno.Command(cmd, { args, stdin: "null", stdout: "null", stderr: "piped" })
    .output()
  if (out.code === 0) return undefined
  if (out.code === REFUSE) return refusal(volumesPath, stack)
  if (out.code === INCOMPLETE) return incomplete(volumesPath, stack)
  const stderr = new TextDecoder().decode(out.stderr).trim()
  return `${stack}: could not check the Postgres data folders (exit ${out.code}): ${stderr}`
}

if (import.meta.main) {
  const env = (key: string) => Deno.env.get(key) || undefined
  const message = await check(env, stackFromUrl(import.meta.url))
  if (message) {
    console.error(message)
    Deno.exit(1)
  }
}
