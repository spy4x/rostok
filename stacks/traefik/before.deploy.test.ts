// Tests for stacks/traefik/before.deploy.ts pure helpers.
// (No shell interaction — those run via the deploy script.)

import { assertEquals, assertNotEquals, assertThrows } from "@std/assert"
import { compareSync, getRounds } from "npm:bcryptjs@3.0.3"

import { hashPassword, resolveHtpasswdCredential } from "./before.deploy.ts"

/** Build a `getEnv` from a plain object, as resolveHtpasswdCredential expects. */
function envFrom(vars: Record<string, string>): (key: string) => string | undefined {
  return (key) => vars[key]
}

Deno.test("hashPassword: bcryptjs.compareSync accepts the original password", () => {
  const hash = hashPassword("correct horse battery staple")
  assertEquals(compareSync("correct horse battery staple", hash), true)
})

Deno.test("hashPassword: bcryptjs.compareSync rejects a wrong password", () => {
  const hash = hashPassword("correct horse battery staple")
  assertEquals(compareSync("wrong password", hash), false)
})

Deno.test("hashPassword: output is a bcrypt hash Traefik's basicAuth accepts", () => {
  const hash = hashPassword("x")
  // $2a$/$2b$/$2y$ + 2-digit cost + "$" + 53-char salt+digest.
  assertEquals(/^\$2[aby]\$\d{2}\$.{53}$/.test(hash), true)
})

Deno.test("hashPassword: cost is pinned at 10", () => {
  // The format check above accepts any 2-digit cost, so a lowered cost
  // (weaker hashing, faster to brute-force) wouldn't fail it. Read the
  // actual cost back out with bcryptjs's own getRounds() instead of
  // matching the hash string, so this doesn't depend on which of
  // $2a/$2b/$2y hashSync happens to emit.
  const hash = hashPassword("x")
  assertEquals(getRounds(hash), 10)
})

Deno.test("hashPassword: two calls for the same password produce different hashes", () => {
  // bcrypt salts each hash — a fixed hash for a fixed password would let
  // an attacker precompute the dashboard credential from the repo.
  const a = hashPassword("same password")
  const b = hashPassword("same password")
  assertNotEquals(a, b)
  assertEquals(compareSync("same password", a), true)
  assertEquals(compareSync("same password", b), true)
})

// ── resolveHtpasswdCredential ───────────────────────────────────────────

Deno.test("resolveHtpasswdCredential: new keys both set — hashes the password", () => {
  const cred = resolveHtpasswdCredential(envFrom({
    TRAEFIK_BASIC_AUTH_USER: "admin",
    TRAEFIK_BASIC_AUTH_PASSWORD: "s3cr3t",
  }))
  assertEquals(cred.user, "admin")
  assertEquals(compareSync("s3cr3t", cred.hash), true)
})

Deno.test("resolveHtpasswdCredential: user set, password missing — names PASSWORD, not USER", () => {
  assertThrows(
    () => resolveHtpasswdCredential(envFrom({ TRAEFIK_BASIC_AUTH_USER: "admin" })),
    Error,
    "TRAEFIK_BASIC_AUTH_PASSWORD is not",
  )
})

Deno.test("resolveHtpasswdCredential: password set, user missing — names USER, not PASSWORD", () => {
  assertThrows(
    () => resolveHtpasswdCredential(envFrom({ TRAEFIK_BASIC_AUTH_PASSWORD: "s3cr3t" })),
    Error,
    "TRAEFIK_BASIC_AUTH_USER is not",
  )
})

Deno.test("resolveHtpasswdCredential: nothing set — throws instead of silently skipping", () => {
  assertThrows(
    () => resolveHtpasswdCredential(envFrom({})),
    Error,
    "No basic-auth credentials set",
  )
})
