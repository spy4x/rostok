// Finds the images of a stack whose tag is a variable.
//
// The catalog's pattern is `image: twinproduction/gatus:${GATUS_IMAGE_TAG:-latest}`:
// the tag is one variable with a default. Only that exact shape is read.
// An image with a hardcoded tag, no tag, or text after the variable
// (`…:${IMMICH_VERSION:-release}-cuda`) is left alone.

import { join } from "@std/path"
import { parse } from "yaml"
import { UserError } from "../errors.ts"
import { resolveStackFiles } from "../deploy/stack-files.ts"

/** One compose image whose tag comes from a variable. */
export interface ComposeImage {
  /** Image name without the tag, e.g. `ghcr.io/twin/gatus`. */
  image: string
  /** The variable that holds the tag, e.g. `GATUS_IMAGE_TAG`. */
  variable: string
  /** The tag compose uses when the variable is unset, e.g. `latest`. */
  defaultTag: string
}

const VARIABLE_TAG = /^([^\s$]+):\$\{([A-Za-z_][A-Za-z0-9_]*):?-([^}]+)\}$/

/**
 * Read the variable-tagged images out of a compose file's text. Two
 * services that share one variable give one entry (the first), since
 * one variable can hold one pin.
 */
export function parseComposeImages(composeText: string): ComposeImage[] {
  const doc = parse(composeText)
  const services = doc && typeof doc === "object" ? doc.services : undefined
  if (!services || typeof services !== "object") return []
  const images: ComposeImage[] = []
  for (const service of Object.values(services as Record<string, unknown>)) {
    const image = (service as { image?: unknown } | null)?.image
    if (typeof image !== "string") continue
    const match = VARIABLE_TAG.exec(image.trim())
    if (!match || images.some((i) => i.variable === match[2])) continue
    images.push({ image: match[1], variable: match[2], defaultTag: match[3] })
  }
  return images
}

/** The stack has a compose file, but it could not be downloaded. The message names the stack. */
export class ComposeReadError extends UserError {
  constructor(message: string) {
    super(message)
    this.name = "ComposeReadError"
  }
}

/** Where `stackImages` reads from. Everything is optional; tests inject all four. */
export interface ComposeSource {
  /** `--catalog`: read `<catalogDir>/<stack>/compose.yml` and nothing else. */
  catalogDir?: string
  /** Used when the CLI is installed from a package host and the file is an https URL. */
  fetch?: typeof fetch
  /** Timeout of that download. */
  timeoutMs?: number
  /** Defaults to the resolver `rostok deploy` uses. */
  resolveFiles?: typeof resolveStackFiles
}

/**
 * The variable-tagged images of `stackName`, or [] when the stack has no
 * compose file. With `catalogDir` (`--catalog`) the compose file is the
 * one next to that catalog's `+meta.ts`; otherwise it is the file
 * `rostok deploy` would use (the project's own `stacks/<name>/`, then
 * the one shipped with the CLI). A CLI installed from a package host
 * downloads the shipped file; when that fails (no connection, no answer
 * in time, any status but 200) this throws a ComposeReadError.
 */
export async function stackImages(
  cwd: string,
  stackName: string,
  source: ComposeSource = {},
): Promise<ComposeImage[]> {
  const text = source.catalogDir
    ? await readLocal(join(source.catalogDir, stackName, "compose.yml"))
    : await readResolved(cwd, stackName, source)
  return text === undefined ? [] : parseComposeImages(text)
}

async function readLocal(path: string | URL): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path)
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined
    throw error
  }
}

async function readResolved(
  cwd: string,
  stackName: string,
  source: ComposeSource,
): Promise<string | undefined> {
  let url: string | undefined
  try {
    url = (await (source.resolveFiles ?? resolveStackFiles)(cwd, stackName)).files.get(
      "compose.yml",
    )
  } catch (error) {
    // Neither in the project nor shipped: a stack without files.
    if (error instanceof UserError) return undefined
    throw error
  }
  if (!url) return undefined
  if (url.startsWith("file:")) return await readLocal(new URL(url))
  // A JSR install serves the shipped files over https.
  const timeoutMs = source.timeoutMs ?? 10_000
  const host = new URL(url).host
  const fail = (reason: string) =>
    new ComposeReadError(`could not read the compose file of stack '${stackName}' (${reason})`)
  let response: Response
  try {
    response = await (source.fetch ?? fetch)(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const name = error instanceof Error ? error.name : ""
    throw fail(
      name === "TimeoutError" || name === "AbortError"
        ? `no answer within ${timeoutMs / 1000}s from ${host}`
        : `${host} unreachable`,
    )
  }
  if (response.status !== 200) {
    await response.body?.cancel()
    throw fail(`${host} answered HTTP ${response.status}`)
  }
  try {
    return await response.text()
  } catch {
    throw fail(`the download from ${host} broke off`)
  }
}
