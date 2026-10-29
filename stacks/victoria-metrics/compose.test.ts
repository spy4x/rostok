// Guards who can read the stack's stores, which take no password, and how long they keep data
// (spy4x/rostok#470).

import { assertEquals } from "@std/assert"
import { parse } from "yaml"

interface Network {
  external?: boolean
  internal?: boolean
  name?: string
}

interface Compose {
  networks: Record<string, Network | null>
  services: Record<string, { networks?: string[]; command?: string[] }>
}

const compose = parse(
  await Deno.readTextFile(new URL("./compose.yml", import.meta.url)),
) as Compose

/** Services whose `networks` list holds `network`. */
function on(network: string): string[] {
  return Object.keys(compose.services)
    .filter((s) => compose.services[s].networks?.includes(network))
    .toSorted()
}

Deno.test("victoria-metrics: no network of the stack is shared with other stacks", () => {
  // The old file aliased `default` to the external `proxy` network, so every container on it could
  // query both stores. Not external and not renamed: no other stack can declare these networks.
  assertEquals(compose.networks, { metrics: { internal: true }, logs: { internal: true } })
})

Deno.test("victoria-metrics: every service lists its networks", () => {
  // A service without `networks` joins the project's default network, which the list must avoid.
  for (const [name, service] of Object.entries(compose.services)) {
    assertEquals(Array.isArray(service.networks), true, name)
  }
})

Deno.test("victoria-metrics: only promtail reaches VictoriaLogs", () => {
  assertEquals(compose.services["victoria-logs"].networks, ["logs"])
  assertEquals(on("logs"), ["promtail", "victoria-logs"])
})

Deno.test("victoria-metrics: vmagent reaches VictoriaMetrics and both exporters", () => {
  assertEquals(on("metrics"), ["cadvisor", "node-exporter", "victoria-metrics", "vmagent"])
})

Deno.test("victoria-metrics: both stores keep data for 14 days", () => {
  // A number without a unit is months: `--retentionPeriod=14` kept data for 14 months.
  for (const store of ["victoria-metrics", "victoria-logs"]) {
    const flags = compose.services[store].command?.filter((f) => f.startsWith("--retentionPeriod"))
    assertEquals(flags, ["--retentionPeriod=14d"], store)
  }
})
