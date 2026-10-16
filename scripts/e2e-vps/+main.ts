/**
 * Deploys rostok to a fresh Hetzner Cloud server the way a new user does, then deletes the server.
 *
 * ```bash
 * deno task e2e:vps local     # rostok from this checkout (before a release)
 * deno task e2e:vps 1.11.0    # rostok from JSR at that version (after it is published)
 * ```
 *
 * It needs `HETZNER_CLOUD_API_TOKEN` in its environment and `ssh`, `ssh-keygen`, `rsync` and
 * `curl` on this machine. The token goes to the Hetzner API in the `Authorization` header and
 * nowhere else: the commands this script starts get an environment without it. It runs locally
 * only, never in CI. How to run it: `docs/contributing/contributing.md`.
 *
 * @module
 */
import { parse as parseEnv } from "@std/dotenv"
import { join } from "@std/path"
import {
  type Call,
  cheapestX86,
  createCall,
  createKey,
  createServer,
  deleteLabelled,
  type Kind,
  LABEL,
  listLabelled,
  ofRun,
  olderThanStale,
  type Server,
  tokenFromEnv,
} from "./hetzner.ts"
import { waitFor } from "./wait.ts"

const RUN_DEADLINE_MS = 20 * 60_000
const SERVER = "e2e"
const DOMAIN = "example.com"
const STACKS = ["traefik", "gatus", "librespeed", "piped"]

/** Installs Docker the way its own documentation tells a new user to. */
const CLOUD_INIT = `#cloud-config
runcmd:
  - curl -fsSL https://get.docker.com | sh
`

/** Where rostok comes from: this checkout, or JSR at a version. */
export type Target = { kind: "local" } | { kind: "jsr"; version: string }

/**
 * Reads the one argument: `local`, or a version such as `1.11.0`.
 *
 * @throws When the argument is missing or is neither.
 */
export function parseTarget(args: string[]): Target {
  const [arg] = args
  if (args.length === 1 && arg === "local") return { kind: "local" }
  if (args.length === 1 && /^\d+\.\d+\.\d+$/.test(arg)) return { kind: "jsr", version: arg }
  throw new Error(
    "usage: deno task e2e:vps local | <version>\n" +
      "  local      install rostok from this checkout\n" +
      "  <version>  install rostok from JSR at that version, for example 1.11.0",
  )
}

/** The run id: the start time in UTC, in a form a Hetzner label value and a hostname accept. */
export function runIdFrom(date: Date): string {
  return date.toISOString().replace(/\.\d+Z$/, "z").replace(/[-:]/g, "").toLowerCase()
}

/** One HTTP check through Traefik: the `Host` header picks the service, no DNS involved. */
interface HttpCheck {
  host: string
  path: string
  /** Variables of the server's `.env` holding the basic-auth user and password. */
  auth?: [string, string]
}

const HTTP_CHECKS: HttpCheck[] = [
  {
    host: `traefik.${DOMAIN}`,
    path: "/dashboard/",
    auth: ["TRAEFIK_BASIC_AUTH_USER", "TRAEFIK_BASIC_AUTH_PASSWORD"],
  },
  { host: `uptime.${DOMAIN}`, path: "/" },
  { host: `speedtest.${DOMAIN}`, path: "/" },
  { host: `piped.${DOMAIN}`, path: "/" },
  { host: `pipedapi.${DOMAIN}`, path: "/healthcheck" },
]

export interface Ctx {
  /** The run's own `mktemp -d` folder: key, ssh config, rostok install and the project. */
  dir: string
  /** Aborted by the run deadline or one of {@link SIGNALS}. */
  signal: AbortSignal
  /** Environment of every command the run starts. It never holds the API token. */
  env: Record<string, string>
  /** Checks that failed; the run goes on after one so a single run reports them all. */
  failures: string[]
  start: number
}

/**
 * Prints one progress line. It never throws: once the terminal is closed (SIGHUP), every write
 * fails with an I/O error, and a throwing log would stop the cleanup before it deletes the server.
 */
function log(ctx: { start: number }, message: string) {
  const s = Math.round((Date.now() - ctx.start) / 1000)
  try {
    console.log(`[e2e ${String(s).padStart(4)}s] ${message}`)
  } catch {
    // Nobody is left to read it.
  }
}

function fail(ctx: Ctx, message: string) {
  ctx.failures.push(message)
  log(ctx, `FAILED: ${message}`)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Absolute path of a program, so the ssh wrapper can call the real `ssh` without `PATH`. */
async function findOnPath(name: string): Promise<string> {
  for (const dir of (Deno.env.get("PATH") ?? "").split(":")) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      if ((await Deno.stat(candidate)).isFile) return candidate
    } catch {
      // not in this directory
    }
  }
  throw new Error(`${name} is not installed on this machine (not found on PATH)`)
}

interface CommandOptions {
  cwd?: string
  stdin?: string
  timeoutMs: number
  /** Collect the output instead of showing it. */
  capture?: boolean
}

/**
 * Runs one command with the run's environment and its own deadline.
 *
 * @returns The exit code and, with `capture`, stdout followed by stderr.
 * @throws When the command passes its deadline or the run is aborted.
 */
async function command(
  ctx: Ctx,
  argv: string[],
  opts: CommandOptions,
): Promise<{ code: number; out: string }> {
  const timeout = AbortSignal.timeout(opts.timeoutMs)
  const child = new Deno.Command(argv[0], {
    args: argv.slice(1),
    cwd: opts.cwd,
    env: ctx.env,
    clearEnv: true,
    stdin: opts.stdin === undefined ? "null" : "piped",
    stdout: opts.capture ? "piped" : "inherit",
    stderr: opts.capture ? "piped" : "inherit",
    signal: AbortSignal.any([ctx.signal, timeout]),
  }).spawn()
  if (opts.stdin !== undefined) {
    const writer = child.stdin.getWriter()
    await writer.write(new TextEncoder().encode(opts.stdin))
    await writer.close()
  }
  let code: number
  let out = ""
  if (opts.capture) {
    const result = await child.output()
    const decoder = new TextDecoder()
    code = result.code
    out = decoder.decode(result.stdout) + decoder.decode(result.stderr)
  } else {
    code = (await child.status).code
  }
  ctx.signal.throwIfAborted()
  if (timeout.aborted) {
    throw new Error(
      `gave up after ${Math.round(opts.timeoutMs / 1000)} s waiting for \`${argv.join(" ")}\``,
    )
  }
  return { code, out }
}

/** Runs a command that must succeed, showing its output. */
async function must(ctx: Ctx, argv: string[], opts: CommandOptions): Promise<void> {
  log(ctx, `$ ${argv.join(" ")}`)
  const { code } = await command(ctx, argv, opts)
  if (code !== 0) throw new Error(`\`${argv.join(" ")}\` exited with ${code}`)
}

/** Runs a shell script on the server as root and returns its output. */
async function remote(
  ctx: Ctx,
  ip: string,
  script: string,
  extraSshOptions: string[] = [],
): Promise<{ code: number; out: string }> {
  return await command(ctx, [
    join(ctx.dir, "bin", "ssh"),
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    ...extraSshOptions,
    `root@${ip}`,
    "--",
    script,
  ], { timeoutMs: 60_000, capture: true })
}

/**
 * Writes the throwaway key, an ssh config that uses only that key and its own `known_hosts`, and
 * an `ssh` wrapper that goes first on `PATH`. ssh reads `~/.ssh` from the account, not from
 * `HOME`, so the wrapper is the one way to keep rostok's ssh and rsync calls away from the
 * user's own keys and `known_hosts`. The wrapper calls the real ssh by its absolute path and
 * refuses to run when it finds itself called by itself.
 */
async function prepareSsh(ctx: Ctx, runId: string): Promise<string> {
  const realSsh = await findOnPath("ssh")
  const key = join(ctx.dir, "id_ed25519")
  await must(ctx, [
    await findOnPath("ssh-keygen"),
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    `${LABEL}-${runId}`,
    "-f",
    key,
  ], { timeoutMs: 30_000 })
  const config = join(ctx.dir, "ssh_config")
  await Deno.writeTextFile(
    config,
    [
      "Host *",
      `  IdentityFile ${key}`,
      "  IdentitiesOnly yes",
      "  IdentityAgent none",
      `  UserKnownHostsFile ${join(ctx.dir, "known_hosts")}`,
      "  GlobalKnownHostsFile /dev/null",
      "",
    ].join("\n"),
  )
  await Deno.mkdir(join(ctx.dir, "bin"))
  await Deno.writeTextFile(
    join(ctx.dir, "bin", "ssh"),
    [
      "#!/bin/sh",
      'if [ -n "$ROSTOK_E2E_SSH_DEPTH" ]; then',
      '  echo "rostok e2e: the ssh wrapper was called by itself" >&2',
      "  exit 97",
      "fi",
      `ROSTOK_E2E_SSH_DEPTH=1 exec ${shellQuote(realSsh)} -F ${shellQuote(config)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  )
  return (await Deno.readTextFile(`${key}.pub`)).trim()
}

/** Creates the key and the cheapest x86 server that is in stock, and waits until it runs. */
async function createMachine(
  ctx: Ctx,
  call: Call,
  runId: string,
  publicKey: string,
): Promise<string> {
  const keyId = await createKey(call, runId, publicKey)
  const offers = (await cheapestX86(call)).slice(0, 4)
  if (offers.length === 0) throw new Error("the Hetzner API lists no x86 server type")
  let server: Server | undefined
  const errors: string[] = []
  for (const offer of offers) {
    ctx.signal.throwIfAborted()
    try {
      server = await createServer(call, runId, offer, keyId, CLOUD_INIT)
      log(ctx, `created server ${server.name}: ${offer.type} in ${offer.location}`)
      break
    } catch (err) {
      errors.push(`${offer.type} in ${offer.location}: ${(err as Error).message}`)
    }
  }
  if (!server) throw new Error(`could not create a server:\n  ${errors.join("\n  ")}`)
  const id = server.id
  return await waitFor(`server ${server.name} to reach the status "running"`, 180_000, async () => {
    const current: Server = (await call("GET", `/servers/${id}`)).server
    const ip = current.public_net?.ipv4?.ip
    return current.status === "running" && ip ? ip : undefined
  }, ctx.signal)
}

/** Waits for the server to accept the key, then for cloud-init to finish installing Docker. */
async function waitForDocker(ctx: Ctx, ip: string): Promise<void> {
  await waitFor("the server to accept the SSH key", 240_000, async () => {
    // The first login records the host key, as a user's own first `ssh` to the server does.
    const { code, out } = await remote(ctx, ip, "true", ["-o", "StrictHostKeyChecking=accept-new"])
    if (code !== 0) throw new Error(out.trim().split("\n").at(-1) ?? `exit ${code}`)
    return true
  }, ctx.signal)
  log(ctx, "SSH is up")
  await waitFor(
    "cloud-init to finish and `docker compose version` to answer",
    480_000,
    async () => {
      const { code, out } = await remote(
        ctx,
        ip,
        "test -f /var/lib/cloud/instance/boot-finished && docker compose version",
      )
      if (code !== 0) throw new Error(out.trim().split("\n").at(-1) || "cloud-init still running")
      return true
    },
    ctx.signal,
  )
  log(ctx, "Docker is installed")
}

/** Installs rostok into the run's folder, from this checkout or from JSR. */
async function installRostok(ctx: Ctx, target: Target, cwd: string): Promise<string> {
  const root = new URL("../../", import.meta.url).pathname
  const source = target.kind === "local"
    ? ["--config", join(root, "deno.jsonc"), join(root, "cli", "+main.ts")]
    // A version published in the last day is refused without the dependency-age flag.
    : ["--minimum-dependency-age=0", `jsr:@rostok/cli@${target.version}`]
  await must(ctx, [
    Deno.execPath(),
    "install",
    "--global",
    "--allow-all",
    "--force",
    "--name",
    "rostok",
    "--root",
    ctx.dir,
    ...source,
  ], { cwd, timeoutMs: 300_000 })
  const rostok = join(ctx.dir, "bin", "rostok")
  await must(ctx, [rostok, "--version"], { cwd, timeoutMs: 120_000 })
  return rostok
}

/** Containers and deployed files on the server, as sorted lines, to compare two deploys. */
async function snapshot(ctx: Ctx, ip: string, pathApps: string): Promise<string[]> {
  const { code, out } = await remote(
    ctx,
    ip,
    "set -e; " +
      "docker inspect --format 'container {{.Name}} id={{.Id}} started={{.State.StartedAt}}' " +
      "$(docker ps -aq) | sort; " +
      `cd ${shellQuote(pathApps)}; ` +
      "find . -type f -exec sha256sum {} + | sort -k2 | sed 's/^/file /'; " +
      "find . -printf 'mode %m %u:%g %p\\n' | sort -k4",
  )
  if (code !== 0) throw new Error(`could not read the server's state:\n${out}`)
  return out.trim().split("\n")
}

/** Asks for one URL through the server's IP and returns the HTTP status. */
async function httpStatus(
  ctx: Ctx,
  ip: string,
  check: HttpCheck,
  env: Record<string, string>,
): Promise<string> {
  // Traefik answers with its self-signed default certificate: example.com has no DNS, so no
  // certificate authority issues one. The credentials go in on stdin, not on the command line.
  const quoted = (value: string) => value.replace(/[\\"]/g, "\\$&")
  const config = check.auth
    ? `user = "${quoted(env[check.auth[0]] ?? "")}:${quoted(env[check.auth[1]] ?? "")}"\n`
    : ""
  const { out } = await command(ctx, [
    "curl",
    "--silent",
    "--insecure",
    "--max-time",
    "15",
    "--output",
    "/dev/null",
    "--write-out",
    "%{http_code}",
    "--config",
    "-",
    "--header",
    `Host: ${check.host}`,
    `https://${ip}${check.path}`,
  ], { stdin: config, timeoutMs: 30_000, capture: true })
  return out.trim()
}

/** Everything a new user does, and every check; a failed check is recorded, not thrown. */
async function userJourney(ctx: Ctx, target: Target, ip: string): Promise<void> {
  const project = join(ctx.dir, "project")
  await Deno.mkdir(project)
  const rostok = await installRostok(ctx, target, project)
  const run = (args: string[], timeoutMs = 180_000) =>
    must(ctx, [rostok, ...args], { cwd: project, timeoutMs })

  const answers = [
    `SERVER_NAME=${SERVER}`,
    `SSH_ADDRESS=root@${ip}`,
    `DOMAIN=${DOMAIN}`,
    `CONTACT_EMAIL=admin@${DOMAIN}`,
  ]
  await run(["-n", ...answers.flatMap((answer) => ["--var", answer])])
  await run(["env", "setup"])
  for (const stack of STACKS) await run(["stack", "add", stack, "-s", SERVER, "-n"])
  await run(["deploy", SERVER], 600_000)

  const envPath = join(project, "servers", SERVER, ".env")
  const env = parseEnv(await Deno.readTextFile(envPath))
  const pathApps = env.PATH_APPS

  try {
    await waitFor("every container to be running and healthy", 360_000, async () => {
      const { out } = await remote(ctx, ip, "docker ps -a --format '{{.Names}} {{.Status}}'")
      const lines = out.trim().split("\n").filter(Boolean)
      const notReady = lines.filter((l) => !/ Up /.test(l) || /unhealthy|health: starting/.test(l))
      if (lines.length === 0 || notReady.length > 0) {
        throw new Error(lines.length === 0 ? "no container exists" : notReady.join("; "))
      }
      log(ctx, `${lines.length} containers are running and healthy`)
      return true
    }, ctx.signal)
  } catch (err) {
    ctx.signal.throwIfAborted()
    fail(ctx, (err as Error).message)
  }

  for (const check of HTTP_CHECKS) {
    const url = `https://${check.host}${check.path}`
    try {
      await waitFor(`${url} to answer 200`, 120_000, async () => {
        const status = await httpStatus(ctx, ip, check, env)
        if (status !== "200") throw new Error(`HTTP ${status}`)
        return true
      }, ctx.signal)
      log(ctx, `${url} answers 200`)
    } catch (err) {
      ctx.signal.throwIfAborted()
      fail(ctx, (err as Error).message)
    }
  }

  for (const file of [envPath, join(project, ".env.root")]) {
    try {
      const mode = ((await Deno.stat(file)).mode ?? 0) & 0o777
      if (mode !== 0o600) fail(ctx, `${file} on this machine has mode ${mode.toString(8)}, not 600`)
    } catch (err) {
      fail(ctx, `could not read the mode of ${file}: ${(err as Error).message}`)
    }
  }
  const modes = await remote(
    ctx,
    ip,
    `find ${shellQuote(pathApps)} -type f -name .env -printf '%m %p\\n'`,
  )
  const envFiles = modes.out.trim().split("\n").filter(Boolean)
  if (modes.code !== 0 || envFiles.length === 0) {
    fail(ctx, `found no .env file under ${pathApps} on the server: ${modes.out.trim()}`)
  }
  for (const line of envFiles) {
    if (!line.startsWith("600 ")) fail(ctx, `.env on the server is not mode 600: ${line}`)
  }
  log(ctx, `checked the mode of ${envFiles.length} .env file(s) on the server`)

  const before = await snapshot(ctx, ip, pathApps)
  await run(["deploy", SERVER], 600_000)
  const after = await snapshot(ctx, ip, pathApps)
  const changed = [
    ...before.filter((l) => !after.includes(l)).map((l) => `- ${l}`),
    ...after.filter((l) => !before.includes(l)).map((l) => `+ ${l}`),
  ]
  if (changed.length > 0) {
    fail(
      ctx,
      `the second deploy changed ${changed.length} line(s) of the server's state ` +
        `(- before, + after):\n  ${changed.slice(0, 40).join("\n  ")}`,
    )
  } else {
    log(ctx, `the second deploy changed nothing (${before.length} lines compared)`)
  }
}

/**
 * Deletes this run's server and key, then every labelled server and key older than two hours,
 * then the run's folder. Runs after success, failure, the deadline and a signal alike.
 *
 * @returns What is still left; empty when the account and this machine are clean.
 */
async function cleanup(call: Call, runId: string, dir: string, start: number): Promise<string[]> {
  const problems: string[] = []
  const kinds: Kind[] = ["servers", "ssh_keys"]
  const own = ofRun(runId)
  try {
    await waitFor("this run's server and SSH key to be deleted", 180_000, async () => {
      for (const kind of kinds) {
        for (const name of await deleteLabelled(call, kind, own)) {
          log({ start }, `deleted ${kind} ${name}`)
        }
      }
      for (const kind of kinds) {
        if ((await listLabelled(call, kind)).some(own)) return undefined
      }
      return true
    })
  } catch (err) {
    problems.push((err as Error).message)
  }
  for (const kind of kinds) {
    try {
      for (const name of await deleteLabelled(call, kind, olderThanStale(Date.now()))) {
        log({ start }, `deleted ${kind} ${name}: older than two hours`)
      }
      const left = await listLabelled(call, kind)
      log({ start }, `${kind} labelled ${LABEL} left on the account: ${left.length}`)
    } catch (err) {
      problems.push(`could not sweep stale ${kind}: ${(err as Error).message}`)
    }
  }
  try {
    await Deno.remove(dir, { recursive: true })
    log({ start }, "deleted the run's temp folder")
  } catch (err) {
    problems.push(`could not delete ${dir}: ${(err as Error).message}`)
  }
  return problems
}

/** Signals that stop the run early; each still deletes the server. SIGHUP: the terminal closed. */
export const SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"] as const

/** What {@link run} takes from outside, so a test can drive a run without a server. */
export interface RunDeps {
  call: Call
  runId: string
  /** The run's own temp folder; cleanup deletes it. */
  dir: string
  start: number
  /** Environment of every command the run starts. */
  env: Record<string, string>
  /** `Deno.addSignalListener` outside tests. */
  onSignal: (signal: (typeof SIGNALS)[number], handler: () => void) => void
}

/**
 * Runs `journey` until it ends, fails, passes the deadline or gets one of {@link SIGNALS}, then
 * always runs the cleanup.
 *
 * @returns The process exit code: 0 only when every check passed and nothing is left behind.
 */
export async function run(deps: RunDeps, journey: (ctx: Ctx) => Promise<void>): Promise<number> {
  const { call, runId, dir, start, env } = deps
  const abort = new AbortController()
  const deadline = setTimeout(
    () => abort.abort(new Error("the whole run passed its 20 minute deadline")),
    RUN_DEADLINE_MS,
  )
  for (const sig of SIGNALS) {
    deps.onSignal(sig, () => abort.abort(new Error(`interrupted by ${sig}`)))
  }
  const ctx: Ctx = { dir, signal: abort.signal, env, failures: [], start }

  try {
    await journey(ctx)
  } catch (err) {
    fail(ctx, (err as Error).message)
  } finally {
    clearTimeout(deadline)
  }

  const leftBehind = await cleanup(call, runId, dir, start)
  for (const problem of leftBehind) log(ctx, `LEFT BEHIND: ${problem}`)
  if (ctx.failures.length === 0 && leftBehind.length === 0) {
    log(ctx, "PASSED: deployed, checked, deployed again, and nothing is left behind")
    return 0
  }
  log(ctx, `FAILED: ${ctx.failures.length} failure(s), ${leftBehind.length} cleanup problem(s)`)
  ctx.failures.forEach((failure, i) => log(ctx, `  ${i + 1}. ${failure}`))
  return 1
}

/** Runs the whole test and returns the process exit code. */
async function main(args: string[]): Promise<number> {
  const target = parseTarget(args)
  const call = createCall(tokenFromEnv((key) => Deno.env.get(key)), fetch)
  const start = Date.now()
  const runId = runIdFrom(new Date(start))
  const dir = await Deno.makeTempDir({ prefix: "rostok-e2e-" })

  const env: Record<string, string> = { PATH: `${join(dir, "bin")}:${Deno.env.get("PATH")}` }
  for (const key of ["HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "DENO_DIR", "XDG_CACHE_HOME"]) {
    const value = Deno.env.get(key)
    if (value !== undefined) env[key] = value
  }
  log(
    { start },
    `run ${runId}: rostok ${target.kind === "local" ? "from this checkout" : target.version}`,
  )
  const onSignal = (sig: (typeof SIGNALS)[number], handler: () => void) =>
    Deno.addSignalListener(sig, handler)
  return await run({ call, runId, dir, start, env, onSignal }, async (ctx) => {
    const publicKey = await prepareSsh(ctx, runId)
    const ip = await createMachine(ctx, call, runId, publicKey)
    await waitForDocker(ctx, ip)
    await userJourney(ctx, target, ip)
  })
}

if (import.meta.main) {
  let code = 1
  try {
    code = await main(Deno.args)
  } catch (err) {
    console.error((err as Error).message)
  }
  Deno.exit(code)
}
