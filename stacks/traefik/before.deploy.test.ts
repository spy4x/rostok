// Tests for stacks/traefik/before.deploy.ts pure helpers.
// (No shell interaction — those run via the deploy script.)

import { assertEquals, assertNotEquals } from "@std/assert"
import { compareSync } from "npm:bcryptjs@3.0.3"

import { hashPassword } from "./before.deploy.ts"

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

Deno.test("hashPassword: two calls for the same password produce different hashes", () => {
  // bcrypt salts each hash — a fixed hash for a fixed password would let
  // an attacker precompute the dashboard credential from the repo.
  const a = hashPassword("same password")
  const b = hashPassword("same password")
  assertNotEquals(a, b)
  assertEquals(compareSync("same password", a), true)
  assertEquals(compareSync("same password", b), true)
})
