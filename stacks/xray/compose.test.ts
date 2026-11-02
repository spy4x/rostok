// Guards the Xray config compose builds from `.env` (spy4x/rostok#539): the generated values make
// a config Xray accepts, no port is published, and a client cannot reach the host's LAN.

import { assert, assertEquals } from "@std/assert"
import { decodeBase64Url } from "@std/encoding"
import { parse } from "yaml"
import { renderCompose } from "../compose-interpolate.ts"
import meta from "./+meta.ts"

interface Compose {
  services: { xray: { ports?: string[]; labels: string[] } }
  configs: { "xray-config": { content: string } }
}

/** The `.env` a fresh `rostok stack add xray` writes, from the generated defaults. */
function generatedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const v of meta.variables) {
    env[v.key] = typeof v.default === "function" ? v.default()! : v.default!
  }
  return env
}

async function rendered(env: Record<string, string>): Promise<Compose> {
  return parse(await renderCompose("xray", env)) as Compose
}

Deno.test("the generated private key is 32 bytes, as X25519 needs", () => {
  assertEquals(decodeBase64Url(generatedEnv().XRAY_REALITY_PRIVATE_KEY).length, 32)
})

Deno.test("generated values render to a config with one Reality client", async () => {
  const env = generatedEnv()
  const config = JSON.parse((await rendered(env))["configs"]["xray-config"].content)
  const inbound = config.inbounds[0]
  assertEquals(inbound.settings.clients.length, 1)
  assertEquals(inbound.settings.clients[0].id.length, 36)
  assertEquals(inbound.streamSettings.realitySettings.privateKey, env.XRAY_REALITY_PRIVATE_KEY)
  assertEquals(inbound.streamSettings.realitySettings.shortIds, [env.XRAY_REALITY_SHORT_ID])
  assertEquals(inbound.streamSettings.realitySettings.serverNames, [env.XRAY_REALITY_SNI])
})

Deno.test("traffic to private addresses is blocked, so clients cannot reach the LAN", async () => {
  const config = JSON.parse((await rendered(generatedEnv()))["configs"]["xray-config"].content)
  const rule = config.routing.rules.find((r: { ip?: string[] }) => r.ip?.includes("geoip:private"))
  assertEquals(rule?.outboundTag, "block")
})

Deno.test("no port is published; Traefik passes only the decoy name through", async () => {
  const env = { ...generatedEnv(), XRAY_REALITY_SNI: "decoy.example.com" }
  const xray = (await rendered(env)).services.xray
  assertEquals(xray.ports, undefined)
  assert(xray.labels.includes("traefik.tcp.routers.hl-xray.rule=HostSNI(`decoy.example.com`)"))
  assert(xray.labels.includes("traefik.tcp.routers.hl-xray.tls.passthrough=true"))
})
