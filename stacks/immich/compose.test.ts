// Guards Immich's exposure (spy4x/rostok#551): no Traefik router adds an API key to a request,
// which would let anyone without a login read what that key reads, and no service publishes a
// port that skips Traefik and TLS.

import { assert, assertEquals } from "@std/assert"
import { parse } from "yaml"
import { renderCompose } from "../compose-interpolate.ts"

interface Compose {
  services: Record<string, { labels?: string[]; ports?: unknown[] }>
}

const compose = parse(
  await renderCompose("immich", { IMMICH_DOMAIN: "photos.example.com" }),
) as Compose

Deno.test("immich: no router adds a request header such as an API key", () => {
  for (const [name, service] of Object.entries(compose.services)) {
    const added = (service.labels ?? []).filter((l) => /customrequestheaders/i.test(l))
    assertEquals(added, [], `${name} adds request headers at Traefik`)
  }
})

Deno.test("immich: no service publishes a port on the host", () => {
  for (const [name, service] of Object.entries(compose.services)) {
    assert(!service.ports?.length, `${name} publishes ${JSON.stringify(service.ports)}`)
  }
})
