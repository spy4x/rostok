import { assertEquals } from "@std/assert"
import { isPrerelease, newestInFamily, parseVersionTag } from "./version.ts"

const version = (tag: string) => {
  const parsed = parseVersionTag(tag)
  if (!parsed) throw new Error(`fixture tag "${tag}" is not a version`)
  return parsed
}

Deno.test("parseVersionTag reads v1.2.3, 1.2, 16, 2024.10.1 and a suffixed tag", () => {
  assertEquals(parseVersionTag("v1.2.3"), {
    tag: "v1.2.3",
    prefix: "v",
    parts: [1, 2, 3],
    suffix: "",
  })
  assertEquals(parseVersionTag("1.2")?.parts, [1, 2])
  assertEquals(parseVersionTag("16")?.parts, [16])
  assertEquals(parseVersionTag("2024.10.1")?.parts, [2024, 10, 1])
  assertEquals(parseVersionTag("1.27.3-alpine")?.suffix, "alpine")
})

Deno.test("parseVersionTag ignores latest, nightly, a commit tag and a date stamp", () => {
  for (const tag of ["latest", "nightly", "alpine", "sha-1a2b3c4", "20241013", "1.2.3.4.5", ""]) {
    assertEquals(parseVersionTag(tag), null, tag)
  }
})

Deno.test("isPrerelease is true for rc, beta and nightly suffixes and false for alpine", () => {
  for (const tag of ["1.2.3-rc1", "2.0.0-beta.2", "1.4-nightly", "3.0.0-alpine-rc.1"]) {
    assertEquals(isPrerelease(version(tag)), true, tag)
  }
  for (const tag of ["1.2.3", "1.27.3-alpine", "5.4.1-ls250", "1.2.3-cuda"]) {
    assertEquals(isPrerelease(version(tag)), false, tag)
  }
})

Deno.test("newestInFamily keeps the v prefix, the suffix and the number of parts, and skips pre-releases", () => {
  const tags = [
    "latest",
    "1.27.3-alpine",
    "1.28.0-alpine",
    "1.29.0", // no suffix
    "v1.30.0-alpine", // other prefix
    "1.31-alpine", // rolling tag, fewer parts
    "1.32.0-rc1-alpine", // not the same suffix
    "1.28.1-alpine",
  ]
  assertEquals(newestInFamily(tags, version("1.27.3-alpine"), false).tag, "1.28.1-alpine")
  assertEquals(newestInFamily(["1.3.0-rc1", "1.2.4"], version("1.2.3"), false).tag, "1.2.4")
  assertEquals(newestInFamily(["1.2.2", "nightly"], version("1.2.3"), false).tag, "1.2.3")
})

Deno.test("newestInFamily stays inside the major version only when asked to", () => {
  const tags = ["16.4", "16.9", "17.2", "18.0"]
  assertEquals(newestInFamily(tags, version("16.4"), true).tag, "16.9")
  assertEquals(newestInFamily(tags, version("16.4"), false).tag, "18.0")
})
