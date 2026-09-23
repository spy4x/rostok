import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import { UserError } from "../errors.ts"
import { resolveDeployEnv, resolvePathApps, resolveSshUser } from "./env.ts"

Deno.test("resolveSshUser: uses SSH_USER when present, no notice", () => {
  const result = resolveSshUser({ SSH_USER: "deploy" }, "servers/home/.env")
  assertEquals(result.value, "deploy")
  assertEquals(result.notice, undefined)
})

Deno.test("resolveSshUser: falls back to HOMELAB_USER with a rename notice", () => {
  const result = resolveSshUser({ HOMELAB_USER: "homelab" }, "servers/home/.env")
  assertEquals(result.value, "homelab")
  assertStringIncludes(result.notice ?? "", "HOMELAB_USER is deprecated")
  assertStringIncludes(result.notice ?? "", "servers/home/.env")
})

Deno.test("resolveSshUser: falls back to USER (from the file) with a rename notice", () => {
  const result = resolveSshUser({ USER: "spy4x" }, "servers/home/.env")
  assertEquals(result.value, "spy4x")
  assertStringIncludes(result.notice ?? "", "USER is deprecated")
})

Deno.test("resolveSshUser: SSH_USER wins over HOMELAB_USER and USER", () => {
  const result = resolveSshUser({ SSH_USER: "a", HOMELAB_USER: "b", USER: "c" }, "x")
  assertEquals(result.value, "a")
  assertEquals(result.notice, undefined)
})

Deno.test("resolveSshUser: never reads the shell's own USER — only the given map", () => {
  const previous = Deno.env.get("USER")
  Deno.env.set("USER", "shell-user-should-be-ignored")
  try {
    const result = resolveSshUser({}, "servers/home/.env")
    assertEquals(result.value, "")
  } finally {
    if (previous === undefined) Deno.env.delete("USER")
    else Deno.env.set("USER", previous)
  }
})

Deno.test("resolvePathApps: uses PATH_APPS when present, no notice", () => {
  const result = resolvePathApps({ PATH_APPS: "/srv/apps" })
  assertEquals(result.value, "/srv/apps")
  assertEquals(result.notice, undefined)
})

Deno.test("resolvePathApps: falls back to the default with a notice", () => {
  const result = resolvePathApps({})
  assertEquals(result.value, "/srv/apps")
  assertStringIncludes(result.notice ?? "", "PATH_APPS not set")
})

Deno.test("resolveDeployEnv: throws UserError naming every missing key and the file", () => {
  const err = assertThrows(
    () => resolveDeployEnv({ SSH_ADDRESS: "root@example.com" }, "servers/home/.env"),
    UserError,
  )
  assertStringIncludes(err.message, "servers/home/.env")
  // PATH_APPS is never reported missing — it always resolves via the
  // DEFAULT_PATH_APPS fallback.
  for (const key of ["SSH_USER", "VOLUMES_PATH", "PUID", "PGID", "DOCKER_GROUP_ID"]) {
    assertStringIncludes(err.message, key)
  }
  // SSH_ADDRESS was supplied — must not be reported missing.
  assertEquals(err.message.includes("SSH_ADDRESS,"), false)
})

Deno.test("resolveDeployEnv: succeeds and fills SSH_USER + PATH_APPS when all keys resolve", () => {
  const { env, notices } = resolveDeployEnv({
    SSH_ADDRESS: "root@example.com",
    HOMELAB_USER: "homelab",
    VOLUMES_PATH: "/srv/volumes",
    PUID: "1000",
    PGID: "1000",
    DOCKER_GROUP_ID: "988",
  }, "servers/home/.env")
  assertEquals(env.SSH_USER, "homelab")
  assertEquals(env.PATH_APPS, "/srv/apps")
  assertEquals(notices.length, 2)
})
