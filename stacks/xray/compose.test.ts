// Guards the Xray config compose builds from `.env` (spy4x/rostok#539): the generated values make
// a config Xray accepts, no port is published, and a client cannot reach the host's LAN.

import { assert, assertEquals } from "@std/assert"
import { decodeBase64Url } from "@std/encoding"
import { parse } from "yaml"
import { renderCompose } from "../compose-interpolate.ts"
import meta from "./+meta.ts"

interface Compose {
  services: {
    xray: {
      ports?: string[]
      labels: string[]
      pids_limit?: number
      read_only?: boolean
      deploy: { resources: { limits: { pids?: number } } }
    }
  }
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
  // Without it the rule sees only raw IPs: a container name or a name resolving to a LAN address
  // would get through.
  assertEquals(config.routing.domainStrategy, "IPIfNonMatch")
})

Deno.test("no port is published; Traefik passes only the decoy name through", async () => {
  const env = { ...generatedEnv(), XRAY_REALITY_SNI: "decoy.example.com" }
  const xray = (await rendered(env)).services.xray
  assertEquals(xray.ports, undefined)
  assert(xray.labels.includes("traefik.tcp.routers.hl-xray.rule=HostSNI(`decoy.example.com`)"))
  assert(xray.labels.includes("traefik.tcp.routers.hl-xray.tls.passthrough=true"))
  assert(xray.labels.includes("traefik.tcp.routers.hl-xray.entrypoints=websecure"))
})

Deno.test("the process limit sits under deploy limits, where compose accepts it", async () => {
  // docker compose 2.40 refuses `pids_limit` next to `deploy.resources.limits`.
  const xray = (await rendered(generatedEnv())).services.xray
  assertEquals(xray.pids_limit, undefined)
  assertEquals(xray.deploy.resources.limits.pids, 200)
})

Deno.test("the root file system stays writable, so compose can place the config file", async () => {
  // compose refuses a `configs: content:` entry in a `read_only` service.
  assertEquals((await rendered(generatedEnv())).services.xray.read_only, undefined)
})
