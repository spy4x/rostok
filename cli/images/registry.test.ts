import { assertEquals, assertRejects } from "@std/assert"
import { fakeRegistry, sha } from "./fake-registry.test.ts"
import { createRegistryClient, parseImageRef, RegistryError, registryPageUrl } from "./registry.ts"

const ref = (image: string) => {
  const parsed = parseImageRef(image)
  if (!parsed) throw new Error(`fixture image "${image}" has no supported registry`)
  return parsed
}

Deno.test("parseImageRef puts short names on Docker Hub, keeps GHCR and Quay, refuses other registries", () => {
  assertEquals(parseImageRef("nginx"), {
    host: "registry-1.docker.io",
    repository: "library/nginx",
  })
  assertEquals(parseImageRef("vaultwarden/server"), {
    host: "registry-1.docker.io",
    repository: "vaultwarden/server",
  })
  assertEquals(parseImageRef("docker.io/library/postgres")?.repository, "library/postgres")
  assertEquals(parseImageRef("ghcr.io/twin/gatus"), { host: "ghcr.io", repository: "twin/gatus" })
  assertEquals(parseImageRef("quay.io/prometheus/node-exporter")?.host, "quay.io")
  assertEquals(parseImageRef("registry.example.com/team/app"), null)
  assertEquals(parseImageRef("localhost:5000/app"), null)
  assertEquals(parseImageRef("ghcr.io/twin/../other"), null)
})

Deno.test("registryPageUrl links to each registry's own page for the image", () => {
  assertEquals(registryPageUrl(ref("nginx")), "https://hub.docker.com/_/nginx")
  assertEquals(
    registryPageUrl(ref("vaultwarden/server")),
    "https://hub.docker.com/r/vaultwarden/server",
  )
  assertEquals(registryPageUrl(ref("ghcr.io/twin/gatus")), "https://ghcr.io/twin/gatus")
  assertEquals(
    registryPageUrl(ref("quay.io/prometheus/node-exporter")),
    "https://quay.io/repository/prometheus/node-exporter",
  )
})

Deno.test("Docker Hub: gets an anonymous token once, then reads a digest and the tags", async () => {
  const registry = fakeRegistry({
    "registry-1.docker.io/library/nginx": { tags: { latest: sha("a1"), "1.29.1": sha("a1") } },
  })
  const client = createRegistryClient({ fetch: registry.fetch })
  assertEquals(await client.digest(ref("nginx"), "latest"), sha("a1"))
  assertEquals(await client.tags(ref("nginx")), ["latest", "1.29.1"])
  assertEquals(registry.calls, [
    "HEAD https://registry-1.docker.io/v2/library/nginx/manifests/latest",
    "GET https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fnginx%3Apull",
    "HEAD https://registry-1.docker.io/v2/library/nginx/manifests/latest",
    "GET https://registry-1.docker.io/v2/library/nginx/tags/list?n=1000",
  ])
})

Deno.test("GHCR: reads a digest and follows the next-page links to collect every tag", async () => {
  const tags = { latest: sha("b1"), "v5.1.0": sha("b0"), "v5.2.0": sha("b1"), "v5.0.0": sha("b2") }
  const registry = fakeRegistry({ "ghcr.io/twin/gatus": { tags } })
  const client = createRegistryClient({ fetch: registry.fetch })
  assertEquals(await client.digest(ref("ghcr.io/twin/gatus"), "latest"), sha("b1"))
  assertEquals(await client.tags(ref("ghcr.io/twin/gatus")), Object.keys(tags))
  assertEquals(registry.calls.filter((c) => c.includes("/tags/list")).length, 2)
})

Deno.test("Quay: reads a digest and the tags through its own token endpoint", async () => {
  const registry = fakeRegistry({
    "quay.io/prometheus/node-exporter": { tags: { latest: sha("c1"), "v1.8.2": sha("c1") } },
  })
  const client = createRegistryClient({ fetch: registry.fetch })
  const image = ref("quay.io/prometheus/node-exporter")
  assertEquals(await client.digest(image, "v1.8.2"), sha("c1"))
  assertEquals(await client.tags(image), ["latest", "v1.8.2"])
  assertEquals(registry.calls.some((c) => c.startsWith("GET https://quay.io/v2/auth?")), true)
})

Deno.test("tags never follows a next-page link to another host", async () => {
  const calls: string[] = []
  const fetchFn = ((input: string | URL | Request) => {
    calls.push(String(input))
    return Promise.resolve(
      new Response(JSON.stringify({ tags: ["1.0.0"] }), {
        headers: { link: `<https://evil.example.com/v2/twin/gatus/tags/list?n=1000>; rel="next"` },
      }),
    )
  }) as typeof fetch
  const client = createRegistryClient({ fetch: fetchFn })
  assertEquals(await client.tags(ref("ghcr.io/twin/gatus")), ["1.0.0"])
  assertEquals(calls, ["https://ghcr.io/v2/twin/gatus/tags/list?n=1000"])
})

Deno.test("an unreachable registry fails with a RegistryError that names the host", async () => {
  const registry = fakeRegistry({})
  registry.down.add("ghcr.io")
  const client = createRegistryClient({ fetch: registry.fetch })
  await assertRejects(
    () => client.digest(ref("ghcr.io/twin/gatus"), "latest"),
    RegistryError,
    "registry unreachable (ghcr.io)",
  )
})

Deno.test("a rate-limited registry fails with a RegistryError that says so", async () => {
  const registry = fakeRegistry({})
  registry.rateLimited.add("registry-1.docker.io")
  const client = createRegistryClient({ fetch: registry.fetch })
  await assertRejects(
    () => client.tags(ref("nginx")),
    RegistryError,
    "rate-limited by registry-1.docker.io (HTTP 429)",
  )
})

Deno.test("a registry that never answers is given up on after the timeout", async () => {
  // Hangs until the request's own signal aborts it, like a real stalled connection.
  const hangingFetch =
    ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
      })) as typeof fetch
  const client = createRegistryClient({ fetch: hangingFetch, timeoutMs: 20 })
  await assertRejects(
    () => client.digest(ref("ghcr.io/twin/gatus"), "latest"),
    RegistryError,
    "no answer within 0.02s (ghcr.io)",
  )
})

Deno.test("digest refuses a tag that is not a valid tag before any request", async () => {
  const registry = fakeRegistry({})
  const client = createRegistryClient({ fetch: registry.fetch })
  await assertRejects(
    () => client.digest(ref("nginx"), "../../other/manifests/latest"),
    RegistryError,
    "is not a valid tag",
  )
  assertEquals(registry.calls, [])
})

Deno.test("sourceUrl reads the image's source label through the index, the manifest and the config", async () => {
  const registry = fakeRegistry({
    "ghcr.io/twin/gatus": {
      tags: { "v5.2.0": sha("b1") },
      source: "https://github.com/TwiN/gatus",
    },
  })
  const client = createRegistryClient({ fetch: registry.fetch })
  assertEquals(
    await client.sourceUrl(ref("ghcr.io/twin/gatus"), "v5.2.0"),
    "https://github.com/TwiN/gatus",
  )
})

Deno.test("sourceUrl gives nothing for a missing label, a label that is no web link, or a registry error", async () => {
  const registry = fakeRegistry({
    "registry-1.docker.io/library/nginx": { tags: { "1.29.1": sha("a1") } },
    "ghcr.io/twin/gatus": { tags: { "v5.2.0": sha("b1") }, source: "javascript:alert(1)" },
  })
  const client = createRegistryClient({ fetch: registry.fetch })
  assertEquals(await client.sourceUrl(ref("nginx"), "1.29.1"), undefined)
  assertEquals(await client.sourceUrl(ref("ghcr.io/twin/gatus"), "v5.2.0"), undefined)
  assertEquals(await client.sourceUrl(ref("ghcr.io/twin/gatus"), "v9.9.9"), undefined)
})
