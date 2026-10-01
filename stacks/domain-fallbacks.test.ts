// `rostok deploy` never writes a +meta.ts default into an existing server's `.env`; only
// `stack add` does. A server set up before the `*_DOMAIN` variables existed therefore deploys
// with them unset, and compose must still produce the hosts it used before. These tests
// interpolate each compose file with only the server-level `DOMAIN` set and check every host.

import { assertEquals } from "@std/assert"
import { hostsIn, renderCompose } from "./compose-interpolate.ts"

/** Every host a compose file's Traefik routers match, after interpolation, sorted. */
async function hostsOf(stack: string, env: Record<string, string>): Promise<string[]> {
  return [...new Set(hostsIn(await renderCompose(stack, env)))].sort()
}

const env = { DOMAIN: "example.com", STALWART_NEATSOFT_DOMAIN: "example.org" }

Deno.test("bulwark compose.yml: without BULWARK_DOMAIN the host stays webmail.<domain>", async () => {
  assertEquals(await hostsOf("bulwark", env), ["webmail.example.com"])
})

Deno.test("caldiy compose.yml: without CALDIY_DOMAIN the host stays schedule.<domain>", async () => {
  assertEquals(await hostsOf("caldiy", env), ["schedule.example.com"])
})

Deno.test("mig compose.yml: without MIG_DOMAIN the host stays meet.<domain>", async () => {
  assertEquals(await hostsOf("mig", env), ["meet.example.com"])
})

Deno.test("stalwart compose.yml: without the new domain keys the hosts stay as before", async () => {
  assertEquals(await hostsOf("stalwart", env), [
    "mail.example.com",
    "mta-sts.example.com",
    "mta-sts.example.org",
  ])
})

Deno.test("compose.yml: a set domain variable overrides the fallback", async () => {
  assertEquals(await hostsOf("mig", { ...env, MIG_DOMAIN: "book.example.net" }), [
    "book.example.net",
  ])
})

Deno.test("caldiy compose.yml: the app URL falls back to the same host as the router", async () => {
  const text = await renderCompose("caldiy", env)
  assertEquals(
    text.includes("NEXT_PUBLIC_WEBAPP_URL=https://schedule.example.com\n"),
    true,
  )
})
