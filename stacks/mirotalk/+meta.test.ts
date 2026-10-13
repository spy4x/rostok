// mirotalk-specific checks. The checks every +meta.ts shares live in stacks/meta.test.ts.

import { assert, assertEquals, assertRejects } from "@std/assert"
import { renderCompose } from "../compose-interpolate.ts"
import meta from "./+meta.ts"

/** MiroTalk's own minimum: it exits at start with a shorter JWT_KEY (spy4x/rostok#373). */
const UPSTREAM_MIN_KEY_LENGTH = 32

/** Every value the compose file requires; a test removes or blanks the one it is about. */
const ENV = {
  DOMAIN: "example.com",
  MIROTALK_JWT_KEY: "k".repeat(UPSTREAM_MIN_KEY_LENGTH),
  MIROTALK_API_KEY_SECRET: "api-key-of-this-server",
  MIROTALK_TURN_SERVER_USERNAME: "turn-user",
  MIROTALK_TURN_SERVER_CREDENTIAL: "turn-credential",
}

/** `ENV` with one key left out, and with that key blank. */
function withoutValue(key: keyof typeof ENV): Record<string, string>[] {
  const { [key]: _, ...missing } = ENV
  return [missing, { ...ENV, [key]: "" }]
}

Deno.test("mirotalk compose: the container gets MIROTALK_JWT_KEY as JWT_KEY", async () => {
  const rendered = await renderCompose("mirotalk", ENV)
  assertEquals(rendered.match(/^ +- JWT_KEY=.*$/gm), [`      - JWT_KEY=${ENV.MIROTALK_JWT_KEY}`])
})

Deno.test("mirotalk compose: an .env with no or a blank MIROTALK_JWT_KEY does not render", async () => {
  // Compose refuses a `${KEY:?}` without a value, so the deploy stops before the container
  // starts and restarts forever.
  for (const env of withoutValue("MIROTALK_JWT_KEY")) {
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

Deno.test("mirotalk compose: the container gets MIROTALK_API_KEY_SECRET as API_KEY_SECRET", async () => {
  // Without API_KEY_SECRET the image falls back to a key printed in MiroTalk's documentation, and
  // its API answers to anyone who read it (spy4x/rostok#379).
  const rendered = await renderCompose("mirotalk", ENV)
  assertEquals(rendered.match(/^ +- API_KEY_SECRET=.*$/gm), [
    `      - API_KEY_SECRET=${ENV.MIROTALK_API_KEY_SECRET}`,
  ])
})

Deno.test("mirotalk compose: an .env with no or a blank MIROTALK_API_KEY_SECRET does not render", async () => {
  for (const env of withoutValue("MIROTALK_API_KEY_SECRET")) {
    await assertRejects(
      () => renderCompose("mirotalk", env),
      Error,
      "required variable MIROTALK_API_KEY_SECRET is missing a value",
    )
  }
})

Deno.test("mirotalk +meta.ts: the API key is a required secret, generated", () => {
  const spec = meta.variables.find((v) => v.key === "MIROTALK_API_KEY_SECRET")
  assert(spec, "+meta.ts does not declare MIROTALK_API_KEY_SECRET")
  assertEquals(spec.required, true)
  assertEquals(spec.secret, true)
  assertEquals(typeof spec.default, "function")
  const generate = spec.default as () => string
  const key = generate()
  assert(key.length >= 32, `generated key has ${key.length} characters, too few to resist guessing`)
  assert(/^[A-Za-z0-9_-]+$/.test(key), "generated key must need no quoting in .env")
  assert(key !== generate(), "two calls gave the same key, so it is not generated per server")
})

Deno.test("mirotalk compose: MiroTalk and coturn get the same TURN username and credential", async () => {
  const rendered = await renderCompose("mirotalk", ENV)
  assert(rendered.includes("      - TURN_SERVER_USERNAME=turn-user\n"))
  assert(rendered.includes("      - TURN_SERVER_CREDENTIAL=turn-credential\n"))
  assert(rendered.includes("      - --user=turn-user:turn-credential\n"))
})

for (const key of ["MIROTALK_TURN_SERVER_USERNAME", "MIROTALK_TURN_SERVER_CREDENTIAL"] as const) {
  Deno.test(`mirotalk compose: an .env with no or a blank ${key} does not render`, async () => {
    // An empty value used to render: MiroTalk then offered a TURN server nobody can log in to.
    for (const env of withoutValue(key)) {
      await assertRejects(
        () => renderCompose("mirotalk", env),
        Error,
        `required variable ${key} is missing a value`,
      )
    }
  })
}
