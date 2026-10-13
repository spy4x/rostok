// Guards the published ports in compose.yml (spy4x/rostok#8): a deploy with default answers must
// not answer DNS queries from the internet.

import { assertEquals } from "@std/assert"
import { parse } from "yaml"
import { renderCompose } from "../compose-interpolate.ts"

interface Compose {
  services: Record<string, { ports: string[] }>
}

/** The ports the server publishes when the server's `.env` holds `env`. */
async function publishedPorts(env: Record<string, string>): Promise<string[]> {
  const compose = parse(await renderCompose("adguard", env)) as Compose
  return compose.services.adguard.ports
}

Deno.test("adguard: without ADGUARD_DNS_BIND every port is published on loopback only", async () => {
  assertEquals(await publishedPorts({}), [
    "127.0.0.1:53:53/tcp",
    "127.0.0.1:53:53/udp",
    "127.0.0.1:853:853/tcp",
    "127.0.0.1:3000:3000/tcp",
  ])
})

Deno.test("adguard: ADGUARD_DNS_BIND moves the DNS ports to that address and leaves the setup wizard on loopback", async () => {
  assertEquals(await publishedPorts({ ADGUARD_DNS_BIND: "192.0.2.10" }), [
    "192.0.2.10:53:53/tcp",
    "192.0.2.10:53:53/udp",
    "192.0.2.10:853:853/tcp",
    "127.0.0.1:3000:3000/tcp",
  ])
})
