import { assertEquals } from "@std/assert"
import { getRelativePath } from "./+lib.ts"

Deno.test({
  name: "getRelativePath removes cwd prefix from paths",
  fn() {
    // Uses Deno.cwd() internally, so test that a file outside cwd is unchanged
    const cwd = Deno.cwd()
    const testPath = `${cwd}/some/file.txt`
    const result = getRelativePath(testPath)
    // Should strip cwd prefix
    assertEquals(result, "some/file.txt")
  },
})

Deno.test({
  name: "checkDependencies returns availability of sops and age",
  fn: async () => {
    // Import dynamically to avoid module-level side effects
    const { checkDependencies } = await import("./+lib.ts")
    const deps = await checkDependencies()
    // Both should be booleans
    assertEquals(typeof deps.sops, "boolean")
    assertEquals(typeof deps.age, "boolean")
  },
})
