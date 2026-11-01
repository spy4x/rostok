// `rostok upgrade [version]` (alias `update`): replace the rostok binary with a newer release.
//
// Releases live on GitHub (`.woodpecker.yml`, steps `binaries` and `release`): one
// `rostok-<target>.gz` per platform and a `SHA256SUMS` file listing the `.gz` files. The latest
// version is read from the redirect of `<releases>/latest`, which has no API rate limit.
//
// A JSR install (`deno install … jsr:@rostok/cli`) is not a binary rostok can replace: there the
// command prints the `deno install` line to run instead.

import { Command } from "@cliffy/command"
import { encodeHex } from "@std/encoding/hex"
import { dirname } from "@std/path"
import { UserError } from "./errors.ts"
import { NAME, VERSION } from "./version.ts"

/** Where release assets are downloaded from. */
export const RELEASES_URL = "https://github.com/spy4x/rostok/releases"

/**
 * Environment variable that points rostok at another releases URL. It exists for tests, which
 * serve a fake release from a local HTTP server; it is no user setting.
 */
export const TEST_RELEASES_URL_ENV = "ROSTOK_TEST_RELEASES_URL"

/** The platforms a release ships a binary for (`deno compile --target`). */
export const RELEASE_TARGETS = [
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
  "x86_64-apple-darwin",
  "aarch64-apple-darwin",
] as const

/** The releases URL to use: the test override when set, else {@link RELEASES_URL}. */
export function releasesUrl(env: (key: string) => string | undefined = Deno.env.get): string {
  return (env(TEST_RELEASES_URL_ENV) || RELEASES_URL).replace(/\/+$/, "")
}

/** Name of the compressed binary for one target, e.g. `rostok-x86_64-apple-darwin.gz`. */
export function assetName(target: string): string {
  return `${NAME}-${target}.gz`
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/

/** Turns `1.2.3` or `v1.2.3` into `1.2.3`; anything else (a pre-release too) is undefined. */
export function normalizeVersion(value: string): string | undefined {
  const m = value.trim().match(VERSION_RE)
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : undefined
}

/**
 * Compares two `x.y.z` versions numerically: negative when `a` is older, positive when newer,
 * 0 when equal. Throws on a version {@link normalizeVersion} rejects.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const n = normalizeVersion(v)
    if (!n) throw new Error(`not a version: ${v}`)
    return n.split(".").map(Number)
  }
  const [pa, pb] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

/**
 * Reads the latest released version from the redirect `<releases>/latest` answers with
 * (`Location: …/releases/tag/v1.2.3`). Returns undefined when the answer is no such redirect.
 */
export async function fetchLatestVersion(
  base: string,
  opts: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string | undefined> {
  const doFetch = opts.fetch ?? fetch
  const res = await doFetch(`${base}/latest`, { redirect: "manual", signal: opts.signal })
  await res.body?.cancel()
  const location = res.headers.get("location") ?? ""
  const tag = location.match(/\/tag\/([^/?#]+)$/)?.[1]
  return tag ? normalizeVersion(decodeURIComponent(tag)) : undefined
}

/** Parses a `sha256sum` file (`<hex>  <name>` per line) into name → lowercase hex. */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(\S+)$/)
    if (m) sums.set(m[2], m[1].toLowerCase())
  }
  return sums
}

/** Lowercase hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)))
}

/**
 * Throws a UserError unless `bytes` hash to the value `SHA256SUMS` lists for `name`. A missing
 * entry is a refusal too: an unlisted file is never trusted.
 */
export async function verifyChecksum(
  name: string,
  bytes: Uint8Array,
  sumsText: string,
): Promise<void> {
  const expected = parseSha256Sums(sumsText).get(name)
  if (!expected) throw new UserError(`SHA256SUMS of the release does not list ${name}.`)
  const actual = await sha256Hex(bytes)
  if (actual !== expected) {
    throw new UserError(
      `checksum mismatch for ${name}: expected ${expected}, got ${actual}. Nothing was replaced.`,
    )
  }
}

/** `gunzip` in memory. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  )
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** The `deno install` line that moves a JSR install to `version` (latest when undefined). */
export function denoInstallCommand(version?: string): string {
  const spec = version ? `jsr:@rostok/cli@${version}` : "jsr:@rostok/cli"
  return `deno install -g -A --force -n ${NAME} ${spec}`
}

async function download(url: string, doFetch: typeof fetch): Promise<Uint8Array> {
  let res: Response
  try {
    res = await doFetch(url)
  } catch (err) {
    throw new UserError(
      `could not download ${url}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!res.ok) {
    await res.body?.cancel()
    throw new UserError(`could not download ${url}: HTTP ${res.status}`)
  }
  return new Uint8Array(await res.arrayBuffer())
}

/** Everything {@link upgrade} touches outside its own logic, so tests can replace it. */
export interface UpgradeDeps {
  /** Whether this process is a compiled binary (`Deno.build.standalone`). */
  standalone: boolean
  /** `Deno.build.target`. */
  target: string
  /** Absolute path of the running executable. */
  execPath: string
  currentVersion: string
  releasesUrl: string
  fetch: typeof fetch
  log: (line: string) => void
  /** Runs `<path> --version` and returns its stdout; the sanity check of a fresh binary. */
  runVersion: (path: string) => Promise<string>
}

/** Strips ANSI colour codes (cliffy colours `--version`). */
function plain(text: string): string {
  // deno-lint-ignore no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "")
}

/**
 * Upgrades (or moves) this rostok binary to `requested`, or to the latest release when
 * `requested` is undefined. Downloads the target's `.gz` and `SHA256SUMS`, refuses a checksum
 * mismatch, writes the new binary next to the current one, runs it with `--version`, then renames
 * it over the running file, which is atomic on one filesystem. A JSR install only gets the
 * `deno install` line to run.
 */
export async function upgrade(requested: string | undefined, deps: UpgradeDeps): Promise<void> {
  let wanted: string | undefined
  if (requested !== undefined) {
    wanted = normalizeVersion(requested)
    if (!wanted) throw new UserError(`not a version: ${requested} (expected e.g. 1.24.0)`)
  }

  if (!deps.standalone) {
    deps.log(`This ${NAME} runs from a Deno install (JSR), which ${NAME} cannot replace itself.`)
    deps.log(`Run: ${denoInstallCommand(wanted)}`)
    return
  }

  if (!(RELEASE_TARGETS as readonly string[]).includes(deps.target)) {
    throw new UserError(`no ${NAME} release is built for this platform (${deps.target}).`)
  }

  if (!wanted) {
    let latest: string | undefined
    try {
      latest = await fetchLatestVersion(deps.releasesUrl, { fetch: deps.fetch })
    } catch (err) {
      throw new UserError(
        `could not reach ${deps.releasesUrl}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!latest) throw new UserError(`could not read the latest version from ${deps.releasesUrl}.`)
    wanted = latest
  }

  if (compareVersions(wanted, deps.currentVersion) === 0) {
    deps.log(`${NAME} ${deps.currentVersion} is already installed.`)
    return
  }

  const name = assetName(deps.target)
  const base = `${deps.releasesUrl}/download/v${wanted}`

  // The temp file comes first, so a folder rostok cannot write to fails before the download.
  const dir = dirname(deps.execPath)
  let tmp: string
  try {
    tmp = await Deno.makeTempFile({ dir, prefix: `.${NAME}-upgrade-` })
  } catch (err) {
    if (err instanceof Deno.errors.PermissionDenied) {
      throw new UserError(
        `no write permission in ${dir}, so ${deps.execPath} cannot be replaced. ` +
          `Run it as the owner of that folder, e.g. sudo ${deps.execPath} upgrade`,
      )
    }
    throw err
  }
  try {
    deps.log(`Downloading ${NAME} ${wanted} (${deps.target})...`)
    const sums = new TextDecoder().decode(await download(`${base}/SHA256SUMS`, deps.fetch))
    const gz = await download(`${base}/${name}`, deps.fetch)
    await verifyChecksum(name, gz, sums)
    await Deno.writeFile(tmp, await gunzip(gz))
    await Deno.chmod(tmp, 0o755)
    let printed: string
    try {
      printed = plain(await deps.runVersion(tmp))
    } catch (err) {
      throw new UserError(
        `the downloaded binary does not run (${
          err instanceof Error ? err.message : String(err)
        }). Nothing was replaced.`,
      )
    }
    if (!printed.trim().split(/\s+/).includes(wanted)) {
      throw new UserError(
        `the downloaded binary reports "${printed.trim()}", not ${wanted}. Nothing was replaced.`,
      )
    }
    await Deno.rename(tmp, deps.execPath)
  } catch (err) {
    await Deno.remove(tmp).catch(() => {})
    throw err
  }
  deps.log(`${NAME} ${deps.currentVersion} → ${wanted}: ${deps.execPath}`)
}

/** Runs `<path> --version` with update checks off and returns stdout. */
async function runVersion(path: string): Promise<string> {
  const out = await new Deno.Command(path, {
    args: ["--version"],
    env: { ROSTOK_NO_UPDATE_CHECK: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output()
  if (!out.success) throw new Error(`exit code ${out.code}`)
  return new TextDecoder().decode(out.stdout)
}

/** The real dependencies of {@link upgrade}. */
export function defaultUpgradeDeps(): UpgradeDeps {
  return {
    standalone: Deno.build.standalone,
    target: Deno.build.target,
    execPath: Deno.execPath(),
    currentVersion: VERSION,
    releasesUrl: releasesUrl(),
    fetch,
    log: (line) => console.log(line),
    runVersion,
  }
}

export const upgradeCommand = new Command()
  .arguments("[version:string]")
  .description(
    `Replace this rostok binary with the latest release, or with [version].

Downloads the binary for this platform from GitHub, checks it against the
release's SHA256SUMS, and swaps it in place. A Deno (JSR) install prints the
\`deno install\` command to run instead.

Examples:

    rostok upgrade                        # latest release
    rostok upgrade 1.24.0                 # a given version`,
  )
  .action(async (_options: unknown, version?: string) => {
    await upgrade(version, defaultUpgradeDeps())
  })
