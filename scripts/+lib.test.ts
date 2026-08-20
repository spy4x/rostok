import { assertEquals, assertThrows } from "@std/assert"
import { absPath, substituteEnvVars } from "./+lib.ts"

Deno.test("substituteEnvVars replaces environment variables", () => {
  // Mock Deno.env.get
  const mockEnvGet = (key: string) => {
    const env: Record<string, string> = {
      "HOME": "/home/testuser",
      "API_KEY": "secret123",
      "PORT": "3000",
    }
    return env[key]
  }

  assertEquals(
    substituteEnvVars("Home directory: ${HOME}", mockEnvGet),
    "Home directory: /home/testuser",
  )

  assertEquals(
    substituteEnvVars("API: ${API_KEY}:${PORT}", mockEnvGet),
    "API: secret123:3000",
  )

  assertThrows(
    () => substituteEnvVars("Missing: ${MISSING_VAR}", mockEnvGet),
    Error,
    "Environment variable 'MISSING_VAR' not found.",
  )
})

Deno.test("absPath converts tilde to home directory", () => {
  assertEquals(absPath("~/documents", "testuser"), "/home/testuser/documents")
  assertEquals(absPath("/absolute/path", "testuser"), "/absolute/path")
  assertEquals(absPath("relative/path", "testuser"), "relative/path")
})
