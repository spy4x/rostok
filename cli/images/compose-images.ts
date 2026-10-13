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

/**
 * The variable-tagged images of `stackName`, or [] when the stack has no
 * compose file. With `catalogDir` (`--catalog`) the compose file is the
 * one next to that catalog's `+meta.ts`; otherwise it is the file
 * `rostok deploy` would use (the project's own `stacks/<name>/`, then
 * the one shipped with the CLI).
 */
export async function stackImages(
  cwd: string,
  stackName: string,
  catalogDir?: string,
): Promise<ComposeImage[]> {
  const text = catalogDir
    ? await readLocal(join(catalogDir, stackName, "compose.yml"))
    : await readResolved(cwd, stackName)
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

async function readResolved(cwd: string, stackName: string): Promise<string | undefined> {
  let url: string | undefined
  try {
    url = (await resolveStackFiles(cwd, stackName)).files.get("compose.yml")
  } catch (error) {
    // Neither in the project nor shipped: a stack without files.
    if (error instanceof UserError) return undefined
    throw error
  }
  if (!url) return undefined
  if (url.startsWith("file:")) return await readLocal(new URL(url))
  // A JSR install serves the shipped files over https.
  const response = await fetch(url)
  if (!response.ok) {
    await response.body?.cancel()
    return undefined
  }
  return await response.text()
}
