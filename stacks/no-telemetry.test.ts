// Keeps the catalog's services from reporting to their vendors. Each entry is a setting that turns
// off telemetry, crash reports, a vendor tracking script or an update check that is on by default,
// or a host block for a service that has no switch. A rewritten compose file that drops one fails
// here.

import { assert, assertEquals } from "@std/assert"
import { parse } from "yaml"
import { PRIVACY_OPTIONS } from "./syncthing/after.deploy.ts"

interface Service {
  environment?: string[]
  extra_hosts?: string[]
  command?: string[]
}

/** Stack → service → entries its compose service must list under `key`. */
const REQUIRED: [string, string, keyof Service, string[]][] = [
  ["immich", "machine-learning", "environment", [
    "ORT_DISABLE_TELEMETRY=1",
    "HF_HUB_DISABLE_TELEMETRY=1",
  ]],
  ["umami", "umami", "environment", ["DISABLE_TELEMETRY=1", "DISABLE_UPDATES=1"]],
  ["mirotalk", "mirotalk", "environment", ["STATS_ENABLED=false", "SURVEY_ENABLED=false"]],
  ["bulwark", "bulwark", "environment", ["BULWARK_TELEMETRY=off", "BULWARK_UPDATE_CHECK=off"]],
  ["caldiy", "caldiy", "environment", ["CALCOM_TELEMETRY_DISABLED=1"]],
  ["gitea", "gitea", "environment", ["GITEA__cron_0X2E_update_checker__ENABLED=false"]],
  ["woodpecker", "woodpecker-server", "environment", ["WOODPECKER_DISABLE_VERSION_CHECK=true"]],
  ["open-webui", "open-webui", "environment", [
    "ENABLE_VERSION_UPDATE_CHECK=false",
    "HF_HUB_DISABLE_TELEMETRY=1",
  ]],
  ["traefik", "traefik", "command", [
    "--global.checknewversion=false",
    "--global.sendanonymoususage=false",
  ]],
  ["cloudflared", "cloudflared", "extra_hosts", ["sentry.io:0.0.0.0"]],
  ["akaunting", "akaunting", "extra_hosts", ["api.akaunting.com:0.0.0.0"]],
  ["pangolin", "pangolin", "extra_hosts", ["telemetry.fossorial.io:0.0.0.0"]],
]

async function service(stack: string, name: string): Promise<Service> {
  const text = await Deno.readTextFile(new URL(`./${stack}/compose.yml`, import.meta.url))
  const compose = parse(text) as { services: Record<string, Service> }
  const found = compose.services[name]
  assert(found, `${stack}: no service ${name}`)
  return found
}

for (const [stack, name, key, entries] of REQUIRED) {
  Deno.test(`${stack}: ${name} keeps its ${key} telemetry settings`, async () => {
    const listed = (await service(stack, name))[key] ?? []
    for (const entry of entries) assert(listed.includes(entry), `${stack}/${name} lacks ${entry}`)
  })
}

Deno.test("pangolin: its Traefik checks no version and sends no usage data", async () => {
  const text = await Deno.readTextFile(
    new URL("./pangolin/traefik/traefik_config.yml", import.meta.url),
  )
  const config = parse(text) as { global?: Record<string, unknown> }
  assertEquals(config.global, { checkNewVersion: false, sendAnonymousUsage: false })
})

Deno.test("syncthing: deploy turns crash reports off and declines usage reporting", () => {
  assertEquals(PRIVACY_OPTIONS, { crashReportingEnabled: false, urAccepted: -1 })
})
