// before.deploy.ts — stops a deploy that would start Postgres 18 next to data it cannot read
// (#363). Up to rostok 1.21, this stack kept Postgres 16 data in `${VOLUMES_PATH}/<stack>/db`.
// Postgres 18 uses `${VOLUMES_PATH}/<stack>/postgres` instead and would start there with an
// empty database, so the app would look empty. While the old folder exists and the new one
// holds no data, this hook fails the deploy and names the upgrade step.
//
// The same file is in stacks/gitea, stacks/umami and stacks/caldiy (gitea's test checks the
// copies are equal): the hook contract allows no import out of the stack's own folder, so the
// stack name comes from this file's own URL.

const UPGRADE_DOC = "https://github.com/spy4x/rostok/blob/main/docs/usage/postgres-upgrade.md"

/** Exit code of the check script when the deploy must stop. */
export const REFUSE = 3

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
 * A POSIX shell script that exits REFUSE when `<volumes>/<stack>/db` exists and
 * `<volumes>/<stack>/postgres` holds no `<major>/docker` data folder, and 0 otherwise. It reads
 * only the folders' names, so a deploy user who cannot open the Postgres-owned data folder gets
 * the same answer; a stack folder it cannot enter at all is an error (exit 4), never a pass.
 */
export function buildCheckScript(volumesPath: string, stack: string): string {
  const dir = shQuote(`${volumesPath}/${stack}`)
  return [
    `dir=${dir}`,
    `[ ! -d "$dir" ] || [ -x "$dir" ] || { echo "cannot enter $dir" >&2; exit 4; }`,
    `[ -d "$dir/db" ] || exit 0`,
    `for d in "$dir"/postgres/*/docker; do [ -d "$d" ] && exit 0; done`,
    `exit ${REFUSE}`,
  ].join("\n")
}

/** The message a refused deploy prints. */
export function refusal(volumesPath: string, stack: string): string {
  const dir = `${volumesPath}/${stack}`
  return [
    `${stack}: ${dir}/db holds data from Postgres 16 or older, and ${dir}/postgres holds none.`,
    `This version runs Postgres 18 in ${dir}/postgres and would start with an empty database.`,
    `Move the data first, on the server, while the old version still runs:`,
    `  sh upgrade.sh ${volumesPath} ${stack}`,
    `Then deploy again. Steps and where to get upgrade.sh: ${UPGRADE_DOC}`,
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
