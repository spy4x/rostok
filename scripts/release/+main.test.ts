import { assertEquals } from "@std/assert"
import { VERSION } from "../../cli/version.ts"
import { checkReleaseTag, readVersion } from "./+main.ts"

Deno.test("accepts a tag that matches both versions", () => {
  assertEquals(checkReleaseTag("v1.2.1", { a: "1.2.1", b: "1.2.1" }), [])
})

Deno.test("refuses a tag when one version source was not bumped", () => {
  assertEquals(checkReleaseTag("v1.2.2", { a: "1.2.2", b: "1.2.1" }), [
    "b is at 1.2.1, but the tag is v1.2.2.",
  ])
})

Deno.test("refuses a tag without the v prefix", () => {
  assertEquals(checkReleaseTag("1.2.1", { a: "1.2.1" }), ["a is at 1.2.1, but the tag is 1.2.1."])
})

Deno.test("refuses a build with no tag", () => {
  assertEquals(checkReleaseTag(undefined, { a: "1.2.1" }).length, 1)
})

Deno.test("refuses a source that declares no version", () => {
  assertEquals(checkReleaseTag("v1.2.1", { a: undefined }), ["a declares no version."])
})

Deno.test("reads the version from a commented jsonc", () => {
  assertEquals(readVersion('{\n  // comment\n  "name": "x",\n  "version": "1.2.1",\n}'), "1.2.1")
})

Deno.test("deno.jsonc and cli/version.ts declare the same version", async () => {
  const config = await Deno.readTextFile(new URL("../../deno.jsonc", import.meta.url))
  assertEquals(readVersion(config), VERSION)
})
