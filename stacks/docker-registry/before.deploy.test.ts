// Tests for stacks/docker-registry/before.deploy.ts and for the login compose.yml turns on.

import { assert, assertEquals, assertThrows } from "@std/assert"
import { join } from "@std/path"
import { compareSync } from "npm:bcryptjs@3.0.3"
import { parse as parseYaml } from "yaml"

import { resolveHtpasswdLine } from "./before.deploy.ts"
import meta from "./+meta.ts"

function envFrom(vars: Record<string, string>): (key: string) => string | undefined {
  return (key) => vars[key]
}

interface Service {
  environment: string[]
  volumes?: string[]
}
const compose = parseYaml(
  await Deno.readTextFile(new URL("./compose.yml", import.meta.url)),
) as { services: Record<string, Service> }

Deno.test("the htpasswd line holds the user and a bcrypt hash of the password", () => {
  const line = resolveHtpasswdLine(
    envFrom({ DOCKER_REGISTRY_USER: "admin", DOCKER_REGISTRY_PASSWORD: "s3cr3t" }),
  )
  assert(line.endsWith("\n"))
  const [user, hash] = line.trim().split(":")
  assertEquals(user, "admin")
  assertEquals(compareSync("s3cr3t", hash), true)
  assertEquals(compareSync("wrong", hash), false)
  assert(!line.includes("s3cr3t"), "the plain password must not be written")
})

Deno.test("a missing user or password fails instead of writing a login file", () => {
  assertThrows(
    () => resolveHtpasswdLine(envFrom({ DOCKER_REGISTRY_PASSWORD: "s3cr3t" })),
    Error,
    "DOCKER_REGISTRY_USER is not set",
  )
  assertThrows(
    () => resolveHtpasswdLine(envFrom({ DOCKER_REGISTRY_USER: "admin" })),
    Error,
    "DOCKER_REGISTRY_PASSWORD is not set",
  )
})

Deno.test("a user name with a colon is refused", () => {
  assertThrows(
    () =>
      resolveHtpasswdLine(envFrom({ DOCKER_REGISTRY_USER: "a:b", DOCKER_REGISTRY_PASSWORD: "x" })),
    Error,
    "must not contain a colon",
  )
})

Deno.test("the hook writes auth/htpasswd in a deploy staging folder", async () => {
  const staging = await Deno.makeTempDir()
  try {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", new URL("./before.deploy.ts", import.meta.url).href],
      cwd: staging,
      env: { DOCKER_REGISTRY_USER: "admin", DOCKER_REGISTRY_PASSWORD: "s3cr3t" },
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr))
    const text = await Deno.readTextFile(join(staging, "stacks/docker-registry/auth/htpasswd"))
    const [user, hash] = text.trim().split(":")
    assertEquals(user, "admin")
    assertEquals(compareSync("s3cr3t", hash), true)
  } finally {
    await Deno.remove(staging, { recursive: true })
  }
})

Deno.test("the hook exits 1 and writes nothing when the password is missing", async () => {
  const staging = await Deno.makeTempDir()
  try {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", new URL("./before.deploy.ts", import.meta.url).href],
      cwd: staging,
      env: { DOCKER_REGISTRY_USER: "admin", DOCKER_REGISTRY_PASSWORD: "" },
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(out.code, 1)
    assertEquals((await Array.fromAsync(Deno.readDir(staging))).length, 0)
  } finally {
    await Deno.remove(staging, { recursive: true })
  }
})

Deno.test("compose.yml makes the registry ask for the login the hook writes", () => {
  const registry = compose.services["docker-registry"]
  assert(registry.environment.includes("REGISTRY_AUTH=htpasswd"))
  assert(registry.environment.includes("REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd"))
  assert(
    registry.volumes?.some((v) => v.startsWith("./auth/:/auth/:ro")),
    "the hook's auth/ folder must be mounted read-only at /auth",
  )
})

Deno.test("the password is generated, secret, and never handed to a container", () => {
  const spec = meta.variables.find((v) => v.key === "DOCKER_REGISTRY_PASSWORD")!
  assertEquals(spec.required, true)
  assertEquals(spec.secret, true)
  const password = (spec.default as () => string)()
  assert(password.length >= 24, `generated password too short: ${password.length}`)
  for (const [name, service] of Object.entries(compose.services)) {
    assert(
      !service.environment.some((e) => e.includes("DOCKER_REGISTRY_PASSWORD")),
      `${name} must not receive the plain password`,
    )
  }
})
