// mirotalk-specific checks. The checks every +meta.ts shares live in stacks/meta.test.ts.

import { assert, assertEquals, assertRejects } from "@std/assert"
import { renderCompose } from "../compose-interpolate.ts"
import meta from "./+meta.ts"

const ENV = { DOMAIN: "example.com" }

/** MiroTalk's own minimum: it exits at start with a shorter JWT_KEY (spy4x/rostok#373). */
const UPSTREAM_MIN_KEY_LENGTH = 32

Deno.test("mirotalk compose: the container gets MIROTALK_JWT_KEY as JWT_KEY", async () => {
  const key = "k".repeat(UPSTREAM_MIN_KEY_LENGTH)
  const rendered = await renderCompose("mirotalk", { ...ENV, MIROTALK_JWT_KEY: key })
  assertEquals(rendered.match(/^ +- JWT_KEY=.*$/gm), [`      - JWT_KEY=${key}`])
})

Deno.test("mirotalk compose: an .env with no or a blank MIROTALK_JWT_KEY does not render", async () => {
  // Compose refuses a `${KEY:?}` without a value, so the deploy stops before the container
  // starts and restarts forever.
  for (const env of [ENV, { ...ENV, MIROTALK_JWT_KEY: "" }]) {
    await assertRejects(
      () => renderCompose("mirotalk", env),
      Error,
      "required variable MIROTALK_JWT_KEY is missing a value",
    )
  }
})

Deno.test("mirotalk +meta.ts: the JWT key is a required secret, generated long enough to start", () => {
  const spec = meta.variables.find((v) => v.key === "MIROTALK_JWT_KEY")
  assert(spec, "+meta.ts does not declare MIROTALK_JWT_KEY")
  assertEquals(spec.required, true)
  assertEquals(spec.secret, true)
  assertEquals(typeof spec.default, "function")
  const key = (spec.default as () => string)()
  assert(
    key.length >= UPSTREAM_MIN_KEY_LENGTH,
    `generated key has ${key.length} characters, MiroTalk needs ${UPSTREAM_MIN_KEY_LENGTH}`,
  )
  assert(/^[A-Za-z0-9_-]+$/.test(key), "generated key must need no quoting in .env")
})
