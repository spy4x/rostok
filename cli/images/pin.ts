// Pins an image at `rostok stack add`: turns the compose default tag
// (`latest`, `alpine`, `16`) into the exact version it points at today.

import type { EnvEntry } from "../env-files.ts"
import type { ComposeImage } from "./compose-images.ts"
import { parseImageRef, type RegistryClient } from "./registry.ts"
import type { ImageRef } from "./registry.ts"
import { compareVersions, isPrerelease, parseVersionTag, type VersionTag } from "./version.ts"

/** How many version tags are compared with the default tag's digest before giving up. */
const MAX_DIGEST_CHECKS = 25

/**
 * The value to write for an image whose compose default tag is
 * `defaultTag`: the most exact version tag that has the same digest, or
 * `<defaultTag>@sha256:…` when no version tag shares it.
 *
 * When `defaultTag` is itself a version, a pin never crosses its major
 * version. A full version (`3.7.6`, three numbers or more) is already
 * exact and is returned as it is, without asking the registry. A
 * shorter one (`16`, `1.29`) moves with every release, so only more
 * exact tags with the same first number are considered (`16.9`), and
 * the digest form keeps the default tag's own line.
 */
export async function resolvePin(
  client: RegistryClient,
  ref: ImageRef,
  defaultTag: string,
): Promise<string> {
  const line = parseVersionTag(defaultTag)
  if (line && line.parts.length >= 3) return defaultTag
  const digest = await client.digest(ref, defaultTag)
  const candidates: VersionTag[] = []
  for (const tag of await client.tags(ref)) {
    const version = parseVersionTag(tag)
    if (!version || isPrerelease(version)) continue
    const fits = line
      ? version.suffix === line.suffix && version.parts[0] === line.parts[0] &&
        version.parts.length > line.parts.length
      // A word tag: `latest` matches plain versions, `alpine` matches `1.29.1-alpine`.
      : version.suffix === "" || version.suffix === defaultTag
    if (fits) candidates.push(version)
  }
  const ownFamily = (v: VersionTag) => v.suffix === defaultTag ? 1 : 0
  candidates.sort((a, b) => ownFamily(b) - ownFamily(a) || compareVersions(b, a))
  for (const candidate of candidates.slice(0, MAX_DIGEST_CHECKS)) {
    if (await client.digest(ref, candidate.tag) === digest) return candidate.tag
  }
  return `${defaultTag}@${digest}`
}

/**
 * Resolve a pin for each of `images`. An image whose registry is not
 * supported, unreachable or rate-limited gets one warning that names it
 * and no entry: its variable stays unset. Never throws.
 */
export async function pinImages(
  images: ComposeImage[],
  client: RegistryClient,
  warn: (message: string) => void,
): Promise<EnvEntry[]> {
  const entries: EnvEntry[] = []
  for (const { image, variable, defaultTag } of images) {
    try {
      const ref = parseImageRef(image)
      if (!ref) throw new Error("only Docker Hub, GHCR and Quay are supported")
      entries.push({ key: variable, value: await resolvePin(client, ref, defaultTag) })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      warn(
        `rostok: could not pin ${image}:${defaultTag} (${reason}). ${variable} stays unset, so ` +
          `the image follows "${defaultTag}". Run the same \`rostok stack add\` again to pin it.`,
      )
    }
  }
  return entries
}
