import { assertEquals } from "@std/assert"
import { getEnvPathFromAge, getRelativePath } from "./age-lib.ts"

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
  name: "getEnvPathFromAge strips .age suffix",
  fn() {
    assertEquals(getEnvPathFromAge("/x/.env.age"), "/x/.env")
    assertEquals(getEnvPathFromAge("/x/.env.prod.age"), "/x/.env.prod")
    assertEquals(getEnvPathFromAge("/x/.env.root.age"), "/x/.env.root")
    assertEquals(getEnvPathFromAge("/x/servers/home/.env.age"), "/x/servers/home/.env")
  },
})
