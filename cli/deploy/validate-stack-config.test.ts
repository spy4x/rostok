import { assertStringIncludes, assertThrows } from "@std/assert"
import { UserError } from "../errors.ts"
import { validateStackConfigs } from "./validate-stack-config.ts"

const CONFIG_PATH = "servers/home/config.json"

Deno.test("validateStackConfigs: accepts every real catalog/owner stack name on disk", async () => {
  // Every directory under stacks/ in this repo must fit the pattern —
  // the real config.json values this validator has to accept.
  const names: string[] = []
  for await (const entry of Deno.readDir(new URL("../../stacks/", import.meta.url))) {
    if (entry.isDirectory) names.push(entry.name)
  }
  // Should not throw.
  validateStackConfigs(names.map((name) => ({ name })), CONFIG_PATH)
})

Deno.test("validateStackConfigs: accepts a plain lowercase name and deployAs", () => {
  validateStackConfigs(
    [{ name: "librespeed", deployAs: "librespeed-2" }],
    CONFIG_PATH,
  )
})

Deno.test("validateStackConfigs: rejects a name containing a newline", () => {
  const err = assertThrows(
    () => validateStackConfigs([{ name: "evil\ninjected" }], CONFIG_PATH),
    UserError,
  )
  assertStringIncludes(err.message, "stack name")
  assertStringIncludes(err.message, CONFIG_PATH)
})

Deno.test("validateStackConfigs: rejects a name containing a space", () => {
  const err = assertThrows(
    () => validateStackConfigs([{ name: "evil name" }], CONFIG_PATH),
    UserError,
  )
  assertStringIncludes(err.message, "stack name")
})

Deno.test("validateStackConfigs: rejects a name containing ..", () => {
  const err = assertThrows(
    () => validateStackConfigs([{ name: "../escaped" }], CONFIG_PATH),
    UserError,
  )
  assertStringIncludes(err.message, "stack name")
})

Deno.test("validateStackConfigs: rejects a name containing $(x)", () => {
  const err = assertThrows(
    () => validateStackConfigs([{ name: "evil$(x)" }], CONFIG_PATH),
    UserError,
  )
  assertStringIncludes(err.message, "stack name")
})

Deno.test("validateStackConfigs: rejects a bad deployAs even when name is fine", () => {
  const err = assertThrows(
    () => validateStackConfigs([{ name: "librespeed", deployAs: "evil\ninjected" }], CONFIG_PATH),
    UserError,
  )
  assertStringIncludes(err.message, "deployAs")
  assertStringIncludes(err.message, "evil\ninjected")
})

Deno.test("validateStackConfigs: names the bad value in the error", () => {
  const err = assertThrows(
    () => validateStackConfigs([{ name: "evil name" }], CONFIG_PATH),
    UserError,
  )
  assertStringIncludes(err.message, "evil name")
})
