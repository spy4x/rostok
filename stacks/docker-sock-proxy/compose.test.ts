// Guards where the unauthenticated Docker API is reachable from (spy4x/rostok#6).

import { assertEquals } from "@std/assert"
import { parse } from "yaml"

interface Network {
  name?: string
  internal?: boolean
  external?: boolean
}

interface Compose {
  networks: Record<string, Network>
  services: Record<string, { networks?: string[]; network_mode?: string }>
}

const compose = parse(
  await Deno.readTextFile(new URL("./compose.yml", import.meta.url)),
) as Compose

Deno.test("docker-sock-proxy compose.yml: the Docker API is only on its own internal network, never on proxy", () => {
  assertEquals(Object.keys(compose.services), ["docker-sock-proxy"])
  const service = compose.services["docker-sock-proxy"]
  assertEquals(service.network_mode, undefined)
  assertEquals(service.networks, ["docker-api"])
  assertEquals(compose.networks, { "docker-api": { name: "hl-docker-api", internal: true } })
})
