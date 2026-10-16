import { assertEquals, assertStringIncludes } from "@std/assert"
import { fakeRegistry, sha } from "./fake-registry.test.ts"
import { pinImages, resolvePin } from "./pin.ts"
import { createRegistryClient, parseImageRef } from "./registry.ts"

const ref = (image: string) => parseImageRef(image)!

Deno.test("resolvePin: latest becomes the version tag that has the same digest", async () => {
  const registry = fakeRegistry({
    "ghcr.io/twin/gatus": {
      tags: { latest: sha("b1"), "v5.11.0": sha("b0"), "v5.12.1": sha("b1"), "v5": sha("b1") },
    },
  })
  const client = createRegistryClient({ fetch: registry.fetch })
  assertEquals(await resolvePin(client, ref("ghcr.io/twin/gatus"), "latest"), "v5.12.1")
})

Deno.test("resolvePin: a word tag like alpine becomes the matching -alpine version", async () => {
  const registry = fakeRegistry({
    "registry-1.docker.io/library/nginx": {
      tags: {
        alpine: sha("a2"),
        latest: sha("a1"),
        "1.29.1": sha("a1"),
        "1.29.1-alpine": sha("a2"),
        "1.29-alpine": sha("a2"),
      },
    },
  })
  const client = createRegistryClient({ fetch: registry.fetch })
  assertEquals(await resolvePin(client, ref("nginx"), "alpine"), "1.29.1-alpine")
})

Deno.test("resolvePin: when no version tag shares the digest it writes tag@sha256", async () => {
  const registry = fakeRegistry({
    "registry-1.docker.io/mirotalk/p2p": { tags: { latest: sha("d1"), "1.0.0": sha("d0") } },
  })
  const client = createRegistryClient({ fetch: registry.fetch })
  assertEquals(await resolvePin(client, ref("mirotalk/p2p"), "latest"), `latest@${sha("d1")}`)
})

Deno.test("resolvePin: a pre-release that shares the digest is not used as the pin", async () => {
  const registry = fakeRegistry({
    "registry-1.docker.io/mirotalk/p2p": { tags: { latest: sha("d1"), "2.0.0-rc1": sha("d1") } },
  })
  const client = createRegistryClient({ fetch: registry.fetch })
  assertEquals(await resolvePin(client, ref("mirotalk/p2p"), "latest"), `latest@${sha("d1")}`)
})

Deno.test("resolvePin: a version default is pinned inside its own major version", async () => {
  const registry = fakeRegistry({
    "registry-1.docker.io/library/postgres": {
      tags: { "16": sha("e1"), "16.8": sha("e0"), "16.9": sha("e1"), "17.5": sha("e2") },
    },
  })
  const client = createRegistryClient({ fetch: registry.fetch })
  assertEquals(await resolvePin(client, ref("postgres"), "16"), "16.9")
})

Deno.test("resolvePin: never writes another major version, even when that tag shares the digest", async () => {
  // A wrongly pushed 17.5 points at the image that 16 points at.
  const registry = fakeRegistry({
    "registry-1.docker.io/library/postgres": {
      tags: { "16": sha("e1"), "16.8": sha("e0"), "17.5": sha("e1") },
    },
  })
  const client = createRegistryClient({ fetch: registry.fetch })
  assertEquals(await resolvePin(client, ref("postgres"), "16"), `16@${sha("e1")}`)
})

Deno.test("resolvePin: a full version default is already exact and is written without asking the registry", async () => {
  const registry = fakeRegistry({})
  const client = createRegistryClient({ fetch: registry.fetch })
  assertEquals(await resolvePin(client, ref("traefik"), "3.7.6"), "3.7.6")
  assertEquals(registry.calls, [])
})

Deno.test("resolvePin: a default already pinned by digest is exact and is written without asking the registry (#437)", async () => {
  const registry = fakeRegistry({})
  const client = createRegistryClient({ fetch: registry.fetch })
  const pinned = `8-bookworm@${sha("a1")}`
  assertEquals(await resolvePin(client, ref("docker.io/valkey/valkey"), pinned), pinned)
  assertEquals(registry.calls, [])
})

Deno.test("pinImages: an unreachable registry gives one warning naming the image and no entry, others still pin", async () => {
  const registry = fakeRegistry({
    "ghcr.io/twin/gatus": { tags: { latest: sha("b1"), "v5.12.1": sha("b1") } },
  })
  registry.down.add("registry-1.docker.io")
  const warnings: string[] = []
  const entries = await pinImages(
    [
      { image: "nginx", variable: "NGINX_IMAGE_TAG", defaultTag: "alpine" },
      { image: "ghcr.io/twin/gatus", variable: "GATUS_IMAGE_TAG", defaultTag: "latest" },
    ],
    createRegistryClient({ fetch: registry.fetch }),
    (message) => warnings.push(message),
  )
  assertEquals(entries, [{ key: "GATUS_IMAGE_TAG", value: "v5.12.1" }])
  assertEquals(warnings.length, 1)
  assertStringIncludes(warnings[0], "could not pin nginx:alpine (registry unreachable")
  assertStringIncludes(warnings[0], "NGINX_IMAGE_TAG stays unset")
})

Deno.test("pinImages: an image on an unsupported registry is warned about and left unset", async () => {
  const registry = fakeRegistry({})
  const warnings: string[] = []
  const entries = await pinImages(
    [{ image: "registry.example.com/team/app", variable: "APP_IMAGE_TAG", defaultTag: "latest" }],
    createRegistryClient({ fetch: registry.fetch }),
    (message) => warnings.push(message),
  )
  assertEquals(entries, [])
  assertEquals(registry.calls, [])
  assertStringIncludes(warnings[0], "only Docker Hub, GHCR and Quay are supported")
})

// #425: the registry's own text (here a body that is not JSON, quoted in
// the parse error) must not reach the terminal with its control characters.
Deno.test("pinImages: a registry answer with control characters is warned about without them", async () => {
  const body = "\x1b]0;owned\x07\x1b[2J\x9b31m<html>"
  const fakeFetch = (_input: string | URL | Request, init: RequestInit = {}) =>
    Promise.resolve(
      init.method === "HEAD"
        ? new Response(null, { headers: { "docker-content-digest": sha("c1") } })
        : new Response(body),
    )
  const warnings: string[] = []
  const entries = await pinImages(
    [{ image: "ghcr.io/team/app", variable: "APP_IMAGE_TAG", defaultTag: "latest" }],
    createRegistryClient({ fetch: fakeFetch }),
    (message) => warnings.push(message),
  )
  assertEquals(entries, [])
  assertEquals(warnings.length, 1)
  assertStringIncludes(warnings[0], "owned")
  const sent = ["\x1b", "\x07", "\x9b"].filter((c) => warnings[0].includes(c))
  assertEquals(sent, [], JSON.stringify(warnings[0]))
})
