// Guards Vaultwarden's sign-up default (spy4x/rostok#551): a fresh install, and a server whose
// `.env` predates the key, start with sign-ups off, so a stranger cannot open an account.
// Also guards the client address (spy4x/rostok#553): Vaultwarden reads it from X-Real-Ip, which
// Traefik sets from the connection, and no middleware removes it, so visitors keep their own
// login rate limits.

import { assertEquals } from "@std/assert"
import { parse } from "yaml"
import { renderCompose } from "../compose-interpolate.ts"
import meta from "./+meta.ts"

interface Compose {
  services: { vaultwarden: { environment: string[]; labels: string[] } }
}

/** The value compose passes to Vaultwarden's `name` setting for the given `.env`. */
async function setting(name: string, env: Record<string, string>): Promise<string | undefined> {
  const compose = parse(await renderCompose("vaultwarden", env)) as Compose
  const line = compose.services.vaultwarden.environment.find((e) => e.startsWith(`${name}=`))
  return line?.slice(name.length + 1)
}

/** The value compose passes to Vaultwarden's `SIGNUPS_ALLOWED` for the given `.env`. */
function signupsAllowed(env: Record<string, string>): Promise<string | undefined> {
  return setting("SIGNUPS_ALLOWED", env)
}

/** The default `+meta.ts` writes to a fresh `.env` for `key`. */
function metaDefault(key: string): string {
  return String(meta.variables.find((v) => v.key === key)?.default)
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

Deno.test("vaultwarden: a fresh install reads the client address from X-Real-Ip", async () => {
  const env = { VAULTWARDEN_IP_HEADER: metaDefault("VAULTWARDEN_IP_HEADER") }
  assertEquals(await setting("IP_HEADER", env), "X-Real-Ip")
})

Deno.test("vaultwarden: a server whose .env lacks the key reads X-Real-Ip", async () => {
  assertEquals(await setting("IP_HEADER", {}), "X-Real-Ip")
})

Deno.test("vaultwarden: an owner behind Cloudflare can read CF-Connecting-IP", async () => {
  const env = { VAULTWARDEN_IP_HEADER: "CF-Connecting-IP" }
  assertEquals(await setting("IP_HEADER", env), "CF-Connecting-IP")
})

Deno.test("vaultwarden: no router middleware rewrites the client address header", async () => {
  const compose = parse(await renderCompose("vaultwarden", {})) as Compose
  const rewrites = compose.services.vaultwarden.labels.filter((l) =>
    /customrequestheaders\.(x-real-ip|cf-connecting-ip)=/i.test(l)
  )
  assertEquals(rewrites, [])
})

Deno.test("vaultwarden: a fresh install and an older .env both allow invitations", async () => {
  const env = { VAULTWARDEN_INVITATIONS_ALLOWED: metaDefault("VAULTWARDEN_INVITATIONS_ALLOWED") }
  assertEquals(await setting("INVITATIONS_ALLOWED", env), "true")
  assertEquals(await setting("INVITATIONS_ALLOWED", {}), "true")
})
