import { assertEquals, assertRejects } from "@std/assert"
import { join } from "@std/path"
import { ComposeReadError, parseComposeImages, stackImages } from "./compose-images.ts"

Deno.test("parseComposeImages finds variable-tagged images and leaves hardcoded, untagged and suffixed ones alone", () => {
  const images = parseComposeImages(`
services:
  gatus:
    image: ghcr.io/twin/gatus:\${GATUS_IMAGE_TAG:-latest}
  proxy:
    image: "traefik:\${TRAEFIK_IMAGE_TAG:-3.7.6}"
  db:
    image: postgres:\${DB_IMAGE_TAG-16}
  hardcoded:
    image: redis:7.4
  untagged:
    image: busybox
  no-default:
    image: nginx:\${NGINX_IMAGE_TAG}
  suffixed:
    image: ghcr.io/immich-app/immich-machine-learning:\${IMMICH_VERSION:-release}-cuda
  built:
    build: .
`)
  assertEquals(images, [
    { image: "ghcr.io/twin/gatus", variable: "GATUS_IMAGE_TAG", defaultTag: "latest" },
    { image: "traefik", variable: "TRAEFIK_IMAGE_TAG", defaultTag: "3.7.6" },
    { image: "postgres", variable: "DB_IMAGE_TAG", defaultTag: "16" },
  ])
})

Deno.test("parseComposeImages gives one entry when two services share a tag variable", () => {
  const images = parseComposeImages(`
services:
  server:
    image: ghcr.io/immich-app/immich-server:\${IMMICH_VERSION:-release}
  worker:
    image: ghcr.io/immich-app/immich-worker:\${IMMICH_VERSION:-release}
`)
  assertEquals(images.map((i) => i.image), ["ghcr.io/immich-app/immich-server"])
})

Deno.test("stackImages reads the compose file shipped with the CLI, and the project's own copy first", async () => {
  const dir = await Deno.makeTempDir({ prefix: "rostok-compose-images-" })
  try {
    assertEquals(await stackImages(dir, "gatus"), [
      { image: "twinproduction/gatus", variable: "GATUS_IMAGE_TAG", defaultTag: "latest" },
    ])
    await Deno.mkdir(join(dir, "stacks", "gatus"), { recursive: true })
    await Deno.writeTextFile(
      join(dir, "stacks", "gatus", "compose.yml"),
      "services:\n  gatus:\n    image: ghcr.io/twin/gatus:${GATUS_IMAGE_TAG:-stable}\n",
    )
    assertEquals(await stackImages(dir, "gatus"), [
      { image: "ghcr.io/twin/gatus", variable: "GATUS_IMAGE_TAG", defaultTag: "stable" },
    ])
    assertEquals(await stackImages(dir, "not-a-stack"), [])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

// A CLI installed from a package host gets its shipped files as https
// URLs. These tests stand in for that host with a resolver and a fetch.
const COMPOSE_URL = "https://packages.example.com/stacks/gatus/compose.yml"
const shipped = () =>
  Promise.resolve({ files: new Map([["compose.yml", COMPOSE_URL]]), origin: "shipped" as const })

Deno.test("stackImages downloads the shipped compose file through the given fetch", async () => {
  const asked: string[] = []
  const fetchFn = ((input: string | URL | Request) => {
    asked.push(String(input))
    return Promise.resolve(
      new Response(
        "services:\n  gatus:\n    image: ghcr.io/twin/gatus:${GATUS_IMAGE_TAG:-latest}\n",
      ),
    )
  }) as typeof fetch
  assertEquals(await stackImages("/nowhere", "gatus", { fetch: fetchFn, resolveFiles: shipped }), [
    { image: "ghcr.io/twin/gatus", variable: "GATUS_IMAGE_TAG", defaultTag: "latest" },
  ])
  assertEquals(asked, [COMPOSE_URL])
})

Deno.test("stackImages: a package host that refuses the connection fails with an error naming the stack", async () => {
  const fetchFn = (() => Promise.reject(new TypeError("connection refused"))) as typeof fetch
  await assertRejects(
    () => stackImages("/nowhere", "gatus", { fetch: fetchFn, resolveFiles: shipped }),
    ComposeReadError,
    "could not read the compose file of stack 'gatus' (packages.example.com unreachable)",
  )
})

Deno.test("stackImages: a package host that answers 404 for the compose file fails, it is not read as a stack without images", async () => {
  const fetchFn =
    (() => Promise.resolve(new Response("not found", { status: 404 }))) as typeof fetch
  await assertRejects(
    () => stackImages("/nowhere", "gatus", { fetch: fetchFn, resolveFiles: shipped }),
    ComposeReadError,
    "could not read the compose file of stack 'gatus' (packages.example.com answered HTTP 404)",
  )
})

Deno.test("stackImages: a package host that never answers is given up on after the timeout", async () => {
  // Hangs until the request's own signal aborts it, like a real stalled connection.
  const fetchFn =
    ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))
      })) as typeof fetch
  await assertRejects(
    () =>
      stackImages("/nowhere", "gatus", { fetch: fetchFn, resolveFiles: shipped, timeoutMs: 20 }),
    ComposeReadError,
    "could not read the compose file of stack 'gatus' (no answer within 0.02s from packages.example.com)",
  )
})
