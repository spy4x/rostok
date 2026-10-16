// `rostok images outdated` and `rostok images update`: compare each
// pinned tag variable in a server's `.env` with what the registry has
// now, and move the pins forward.

import { join } from "@std/path"
import { decodeEnvValue, readEnvFile, writeEnvFilePreservingFormat } from "../env-files.ts"
import { serverNotFoundMessage, UserError } from "../errors.ts"
import { reencryptAfterWrite } from "../reencrypt.ts"
import { serverDirFor } from "../server-keys.ts"
import { readServerConfig } from "../stack-add.ts"
import { type ComposeSource, stackImages } from "./compose-images.ts"
import { parseImageRef, type RegistryClient, registryPageUrl } from "./registry.ts"
import { compareVersions, newestInFamily, parseVersionTag } from "./version.ts"

/** One tag variable of one stack on one server, and where it stands. */
export interface PinRow {
  server: string
  stack: string
  variable: string
  /** Image name without the tag. */
  image: string
  /** The variable's value in the server's `.env`; undefined when unset. */
  current?: string
  /**
   * - `outdated`: `newest` is a newer pin.
   * - `current`: pinned, nothing newer.
   * - `floating`: unset, or a tag that is not a pin (`latest`, `alpine`).
   * - `unknown`: the registry could not be asked; `detail` says why.
   */
  state: "outdated" | "current" | "floating" | "unknown"
  newest?: string
  detail?: string
  /** After `update`: the image's source link, or its registry page. */
  link?: string
}

const DIGEST_PIN = /^([^@]+)@(sha256:[0-9a-f]{64})$/

/** Names of the servers in the project (`servers/<name>/.env` exists), sorted. */
export async function listServers(cwd: string): Promise<string[]> {
  const names: string[] = []
  try {
    for await (const entry of Deno.readDir(join(cwd, "servers"))) {
      if (!entry.isDirectory) continue
      const hasEnv = await Deno.stat(join(cwd, "servers", entry.name, ".env"))
        .then((s) => s.isFile).catch(() => false)
      if (hasEnv) names.push(entry.name)
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
  }
  return names.sort()
}

/**
 * Check every variable-tagged image of the server's stacks (or of the
 * one `stack`) against the registry. A version pin is compared with the
 * newest tag of the same form; when the compose default tag is itself a
 * version, only within the pin's major version. A digest pin
 * (`latest@sha256:…`) is compared with the digest its tag has now.
 */
export async function checkPins(
  cwd: string,
  server: string,
  client: RegistryClient,
  stack?: string,
  source: ComposeSource = {},
): Promise<PinRow[]> {
  const serverDir = serverDirFor(cwd, server)
  const envPath = join(serverDir, ".env")
  const isServer = await Deno.stat(envPath).then((s) => s.isFile).catch(() => false)
  if (!isServer) throw new UserError(serverNotFoundMessage(server, envPath))

  const stacks = (await readServerConfig(serverDir)).stacks.map((s) => s.name)
  if (stack !== undefined && !stacks.includes(stack)) {
    throw new UserError(`stack '${stack}' is not on server '${server}'.`)
  }
  const env = new Map((await readEnvFile(envPath)).map((e) => [e.key, decodeEnvValue(e.value)]))

  const rows: PinRow[] = []
  for (const name of stack === undefined ? stacks : [stack]) {
    for (const { image, variable, defaultTag } of await stackImages(cwd, name, source)) {
      const current = env.get(variable) || undefined
      const row: PinRow = { server, stack: name, variable, image, current, state: "floating" }
      rows.push(row)
      if (current === undefined) {
        row.detail = `not set, follows "${defaultTag}"`
        continue
      }
      const digestPin = DIGEST_PIN.exec(current)
      const version = parseVersionTag(current)
      if (!digestPin && !version) continue
      try {
        const ref = parseImageRef(image)
        if (!ref) throw new Error("only Docker Hub, GHCR and Quay are supported")
        if (digestPin) {
          const now = await client.digest(ref, digestPin[1])
          row.state = now === digestPin[2] ? "current" : "outdated"
          if (row.state === "outdated") row.newest = `${digestPin[1]}@${now}`
        } else if (version) {
          const sameMajor = parseVersionTag(defaultTag) !== null
          const newest = newestInFamily(await client.tags(ref), version, sameMajor)
          row.state = compareVersions(newest, version) > 0 ? "outdated" : "current"
          if (row.state === "outdated") row.newest = newest.tag
        }
      } catch (error) {
        row.state = "unknown"
        row.detail = error instanceof Error ? error.message : String(error)
      }
    }
  }
  return rows
}

/**
 * Rewrite every outdated pin of `server` (or of one `stack`) in its
 * `.env`, re-encrypt, and attach a link to each moved pin. Returns all
 * rows; the moved ones keep state `outdated` with `newest` now written.
 * Does not deploy.
 */
export async function updatePins(
  cwd: string,
  server: string,
  client: RegistryClient,
  stack?: string,
  source: ComposeSource = {},
): Promise<PinRow[]> {
  const rows = await checkPins(cwd, server, client, stack, source)
  // #425: a tag in the registry's list can still lack a manifest. Write
  // only a version tag whose digest the registry serves now; a digest
  // pin's new value was just read from the registry.
  for (const row of rows) {
    if (row.state !== "outdated" || row.newest === undefined || DIGEST_PIN.test(row.newest)) {
      continue
    }
    try {
      await client.digest(parseImageRef(row.image)!, row.newest)
    } catch (error) {
      row.state = "unknown"
      row.detail = `${row.newest} is listed but cannot be pulled: ${
        error instanceof Error ? error.message : String(error)
      }`
      row.newest = undefined
    }
  }
  const moved = rows.filter((r) => r.state === "outdated" && r.newest !== undefined)
  if (moved.length === 0) return rows
  await writeEnvFilePreservingFormat(
    join(serverDirFor(cwd, server), ".env"),
    moved.map((r) => ({ key: r.variable, value: r.newest! })),
  )
  await reencryptAfterWrite(cwd)
  for (const row of moved) {
    const ref = parseImageRef(row.image)
    if (!ref) continue
    const reference = DIGEST_PIN.exec(row.newest!)?.[2] ?? row.newest!
    row.link = await client.sourceUrl(ref, reference) ?? registryPageUrl(ref)
  }
  return rows
}
