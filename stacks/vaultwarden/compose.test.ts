// Guards Vaultwarden's sign-up default (spy4x/rostok#551): a fresh install, and a server whose
// `.env` predates the key, start with sign-ups off, so a stranger cannot open an account.

import { assertEquals } from "@std/assert"
import { parse } from "yaml"
import { renderCompose } from "../compose-interpolate.ts"
import meta from "./+meta.ts"

interface Compose {
  services: { vaultwarden: { environment: string[] } }
}

/** The value compose passes to Vaultwarden's `SIGNUPS_ALLOWED` for the given `.env`. */
async function signupsAllowed(env: Record<string, string>): Promise<string | undefined> {
  const compose = parse(await renderCompose("vaultwarden", env)) as Compose
  const line = compose.services.vaultwarden.environment.find((e) =>
    e.startsWith("SIGNUPS_ALLOWED=")
  )
  return line?.slice("SIGNUPS_ALLOWED=".length)
}

Deno.test("vaultwarden: a fresh install refuses sign-ups", async () => {
  const key = meta.variables.find((v) => v.key === "VAULTWARDEN_SIGNUPS_ALLOWED")
  const env = { VAULTWARDEN_SIGNUPS_ALLOWED: String(key?.default) }
  assertEquals(await signupsAllowed(env), "false")
})

Deno.test("vaultwarden: a server whose .env lacks the key refuses sign-ups", async () => {
  assertEquals(await signupsAllowed({}), "false")
})

Deno.test("vaultwarden: an owner can still turn sign-ups on", async () => {
  assertEquals(await signupsAllowed({ VAULTWARDEN_SIGNUPS_ALLOWED: "true" }), "true")
})
