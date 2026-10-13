// Image tags as versions.
//
// Most image tags are not strict semver: `v1.2.3`, `1.2`, `16`,
// `2024.10.1`, `1.27.3-alpine`. This module reads those forms and ignores
// every tag it cannot read (`latest`, `nightly`, `sha-1a2b3c4`).

/** A tag that reads as a version: `v1.2.3-alpine` → prefix `v`, parts `[1, 2, 3]`, suffix `alpine`. */
export interface VersionTag {
  tag: string
  prefix: "" | "v"
  parts: number[]
  /** Text after the first `-` (`alpine`, `cuda`, `rc1`), or "" when there is none. */
  suffix: string
}

const VERSION_TAG = /^(v?)(\d+(?:\.\d+){0,3})(?:-([A-Za-z0-9][A-Za-z0-9._-]*))?$/

const PRERELEASE =
  /(^|[._-])(alpha|beta|rc|preview|pre|dev|nightly|snapshot|canary|edge|unstable|next|test)[._-]?\d*($|[._-])/i

/**
 * Read `tag` as a version, or return null. A lone number of five digits
 * or more (`20241013`, a build number) is a date or a counter, not a
 * version line anyone pins to, so it is not read as one.
 */
export function parseVersionTag(tag: string): VersionTag | null {
  const match = VERSION_TAG.exec(tag)
  if (!match) return null
  const parts = match[2].split(".").map(Number)
  if (parts.length === 1 && match[2].length >= 5) return null
  return { tag, prefix: match[1] as "" | "v", parts, suffix: match[3] ?? "" }
}

/** True for `1.2.3-rc1`, `2.0.0-beta.2`, `1.4-nightly`; false for `1.27-alpine`. */
export function isPrerelease(version: VersionTag): boolean {
  return PRERELEASE.test(version.suffix)
}

/**
 * Order two versions: negative when `a` is older. Missing parts count as
 * zero; on a tie the tag with more parts is the greater one, so the most
 * exact tag (`1.29.0` before `1.29`) comes first in a newest-first sort.
 */
export function compareVersions(a: VersionTag, b: VersionTag): number {
  const length = Math.max(a.parts.length, b.parts.length)
  for (let i = 0; i < length; i++) {
    const diff = (a.parts[i] ?? 0) - (b.parts[i] ?? 0)
    if (diff !== 0) return diff
  }
  return a.parts.length - b.parts.length
}

/**
 * The newest tag in `tags` that can replace the pin `current`: same `v`
 * prefix, same suffix and same number of parts (so `16.4` moves to
 * `16.9`, never to the rolling `16`). The suffix rule also keeps a
 * release from moving to a pre-release (`1.3.0-rc1`). With `sameMajor`
 * it also keeps the first number. Returns `current` when nothing newer
 * exists.
 */
export function newestInFamily(
  tags: string[],
  current: VersionTag,
  sameMajor: boolean,
): VersionTag {
  let newest = current
  for (const tag of tags) {
    const candidate = parseVersionTag(tag)
    if (!candidate) continue
    if (candidate.prefix !== current.prefix || candidate.suffix !== current.suffix) continue
    if (candidate.parts.length !== current.parts.length) continue
    if (sameMajor && candidate.parts[0] !== current.parts[0]) continue
    if (compareVersions(candidate, newest) > 0) newest = candidate
  }
  return newest
}
