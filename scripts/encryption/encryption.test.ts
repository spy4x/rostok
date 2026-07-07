import { assertEquals } from "@std/assert"
import { getRelativePath } from "./age-lib.ts"

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
