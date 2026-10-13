import { assertEquals } from "@std/assert"
import { join } from "@std/path"
import { parseComposeImages, stackImages } from "./compose-images.ts"

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
