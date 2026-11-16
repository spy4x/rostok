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
  // query both stores. Now a container reaches them only when someone attaches it on purpose.
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

interface Service {
  volumes?: string[]
  security_opt?: string[]
  command?: string[]
}

const services = compose.services as Record<string, Service>

/** Host-system paths an SELinux-enforcing Docker refuses to relabel, or must never relabel. */
const HOST_PATHS = ["/", "/proc", "/sys", "/var/run", "/var/lib/docker", "/var/log"]

Deno.test("victoria-metrics: no host-system mount asks Docker to relabel it", () => {
  // `:z` on `/`, `/sys` or `/var/log` stops the container on an SELinux host (spy4x/rostok#580).
  for (const [name, service] of Object.entries(services)) {
    for (const volume of service.volumes ?? []) {
      const [source, , mode = ""] = volume.split(":")
      const host = HOST_PATHS.some((p) => source === p || source.startsWith(`${p}/`))
      if (host) assertEquals(/\bz\b|\bZ\b/.test(mode), false, `${name}: ${volume}`)
    }
  }
})

Deno.test("victoria-metrics: containers reading host files run unlabelled", () => {
  for (const name of ["node-exporter", "cadvisor", "promtail"]) {
    assertEquals(services[name].security_opt?.includes("label=disable"), true, name)
  }
})

Deno.test("victoria-metrics: cAdvisor watches Docker containers only", () => {
  // Walking every cgroup of a workstation got it killed and timed out every scrape.
  assertEquals(services.cadvisor.command?.includes("--docker_only=true"), true)
})
