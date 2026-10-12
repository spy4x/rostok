// authelia-specific checks. The checks every +meta.ts shares live in stacks/meta.test.ts.

import { assert, assertEquals, assertRejects } from "@std/assert"
import { hostsIn, renderCompose } from "../compose-interpolate.ts"
import meta from "./+meta.ts"

/** The three secrets Authelia reads from its environment, which win over configuration.yml. */
const SECRET_KEYS = [
  "AUTHELIA_SESSION_SECRET",
  "AUTHELIA_STORAGE_ENCRYPTION_KEY",
  "AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET",
]

const ENV: Record<string, string> = {
  DOMAIN: "example.com",
  AUTHELIA_SESSION_SECRET: "session-value",
  AUTHELIA_STORAGE_ENCRYPTION_KEY: "storage-value",
  AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET: "jwt-value",
}

/** The `KEY=value` items of the rendered compose file's `environment:` lists. */
function environmentOf(rendered: string): string[] {
  return [...rendered.matchAll(/^ +- ([A-Z_]+=.*)$/gm)].map((m) => m[1])
}

Deno.test("authelia compose: the container gets each secret under Authelia's own variable name", async () => {
  const environment = environmentOf(await renderCompose("authelia", ENV))
  for (const key of SECRET_KEYS) {
    assert(environment.includes(`${key}=${ENV[key]}`), `${key} missing in: ${environment}`)
  }
})

Deno.test("authelia compose: an .env with one of the three secrets missing or blank does not render", async () => {
  // Compose refuses a `${KEY:?}` without a value, so the deploy stops instead of starting an
  // Authelia that falls back to whatever configuration.yml holds for that secret.
  for (const key of SECRET_KEYS) {
    const missing = { ...ENV }
    delete missing[key]
    for (const env of [missing, { ...ENV, [key]: "" }]) {
      await assertRejects(
        () => renderCompose("authelia", env),
        Error,
        `required variable ${key} is missing a value`,
      )
    }
  }
})

Deno.test("authelia compose: the container gets no AUTHELIA_ variable besides the three secrets", async () => {
  // Authelia reads every AUTHELIA_* variable as a setting, so the stack's own keys
  // (AUTHELIA_DOMAIN, AUTHELIA_ADMIN_*, AUTHELIA_SMTP_*) must not be passed on by name.
  const env = { ...ENV, AUTHELIA_DOMAIN: "sso.example.com", AUTHELIA_SMTP_PASSWORD: "smtp-value" }
  const names = environmentOf(await renderCompose("authelia", env)).map((item) =>
    item.slice(0, item.indexOf("="))
  ).filter((name) => name.startsWith("AUTHELIA_"))
  assertEquals(names.sort(), [...SECRET_KEYS].sort())
})

Deno.test("authelia compose: the sign-in host is auth.<domain> unless AUTHELIA_DOMAIN names another", async () => {
  assertEquals(hostsIn(await renderCompose("authelia", ENV)), ["auth.example.com"])
  assertEquals(
    hostsIn(await renderCompose("authelia", { ...ENV, AUTHELIA_DOMAIN: "sso.example.com" })),
    ["sso.example.com"],
  )
})

Deno.test("authelia +meta.ts: the three secrets and the first password are required, generated and all different", () => {
  const values: string[] = []
  for (const key of [...SECRET_KEYS, "AUTHELIA_ADMIN_PASSWORD"]) {
    const spec = meta.variables.find((v) => v.key === key)
    assert(spec, `+meta.ts does not declare ${key}`)
    assertEquals(spec.required, true, key)
    assertEquals(spec.secret, true, key)
    assertEquals(typeof spec.default, "function", key)
    const value = (spec.default as () => string)()
    // Authelia refuses a storage encryption key shorter than 20 characters.
    assert(value.length >= 32, `${key}: generated value has ${value.length} characters`)
    assert(/^[A-Za-z0-9_-]+$/.test(value), `${key}: generated value must need no quoting in .env`)
    values.push(value)
  }
  assertEquals(new Set(values).size, values.length, "two keys got the same generated value")
})
