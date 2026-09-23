import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert"
import { join, resolve } from "@std/path"
import { UserError } from "./errors.ts"
import {
  DEPLOY_REQUIRED_KEYS,
  isServerKey,
  SERVER_KEYS,
  serverDirFor,
  stackKeyPrefix,
  validateRemotePath,
  validateServerName,
  validateSshAddress,
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

Deno.test("accepts ordinary SSH targets", () => {
  for (
    const v of [
      "homelab",
      "192.0.2.1",
      "root@192.0.2.1",
      "deploy@host.example.com",
      "2001:db8::1",
      "my_alias",
    ]
  ) {
    validateSshAddress(v)
  }
})

Deno.test("rejects SSH targets that ssh would read as options", () => {
  for (
    const v of [
      "",
      "-oProxyCommand=touch x",
      "-p",
      "root@host x",
      "host\n",
      "a\tb",
      "h;id",
      "$(id)",
    ]
  ) {
    assertThrows(() => validateSshAddress(v), UserError, "invalid SSH_ADDRESS")
  }
})

Deno.test("accepts plain absolute remote paths", () => {
  for (const v of ["/srv/apps", "/", "/home/deploy/apps_1", "/srv/v-1.2"]) {
    validateRemotePath("PATH_APPS", v)
  }
})

Deno.test("rejects remote paths with shell metacharacters or ..", () => {
  for (
    const v of ["srv/apps", "/srv/$(touch x)", "/srv/a;b", "/srv/a b", "/srv/../etc", "~/apps"]
  ) {
    assertThrows(() => validateRemotePath("PATH_APPS", v), UserError, "invalid PATH_APPS")
  }
})
