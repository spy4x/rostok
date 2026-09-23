import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert"
import { join, resolve } from "@std/path"
import { UserError } from "./errors.ts"
import {
  DEPLOY_REQUIRED_KEYS,
  isServerKey,
  SERVER_KEYS,
  serverDirFor,
  stackKeyPrefix,
  validateServerName,
} from "./server-keys.ts"

Deno.test("accepts ordinary server names", () => {
  for (const name of ["home", "cloud-1", "a", "0", "x".repeat(63)]) {
    validateServerName(name)
  }
})

Deno.test("rejects names that escape servers/ or break shell commands", () => {
  const bad = [
    "",
    ".",
    "..",
    "../x",
    "../../escaped",
    "a/b",
    "/etc",
    "home.",
    "-home",
    "Home",
    "home server",
    "home;rm",
    "x".repeat(64),
  ]
  for (const name of bad) {
    assertThrows(() => validateServerName(name), UserError, "invalid server name")
  }
})

Deno.test("serverDirFor returns the folder under servers/", () => {
  assertEquals(serverDirFor("/p", "home"), join(resolve("/p"), "servers", "home"))
})

Deno.test("serverDirFor refuses path traversal", () => {
  assertThrows(() => serverDirFor("/p", "../x"), UserError)
})

Deno.test("deploy only requires keys that server create writes", () => {
  for (const key of DEPLOY_REQUIRED_KEYS) {
    assert((SERVER_KEYS as readonly string[]).includes(key), key)
  }
})

Deno.test("isServerKey covers SERVER_KEYS and PATH_*", () => {
  assert(isServerKey("DOMAIN"))
  assert(isServerKey("PATH_MEDIA"))
  assertFalse(isServerKey("LIBRESPEED_IMAGE_TAG"))
  assertFalse(isServerKey("USER"))
})

Deno.test("stackKeyPrefix uppercases and replaces dashes", () => {
  assertEquals(stackKeyPrefix("librespeed"), "LIBRESPEED_")
  assertEquals(stackKeyPrefix("deepseek-harness"), "DEEPSEEK_HARNESS_")
})
