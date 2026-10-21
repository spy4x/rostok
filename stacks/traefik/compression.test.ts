// Guards the compression middleware in dynamic/00-base.yml (spy4x/rostok#494). It runs on every
// websecure router. Traefik matches its content types exactly, so it lists the text types to
// compress: a compressed video loses its length, and a CDN that caches it breaks seeking.

import { assertEquals } from "@std/assert"
import { parse } from "yaml"

interface CompressMiddleware {
  compress: { includedContentTypes?: string[]; excludedContentTypes?: string[] }
}

const base = parse(
  await Deno.readTextFile(new URL("./dynamic/00-base.yml", import.meta.url)),
) as { http: { middlewares: Record<string, CompressMiddleware> } }

const compress = base.http.middlewares["compression"]!.compress
const included = compress.includedContentTypes ?? []

/** Already-compressed media, or a stream that must not be held back. */
const NEVER = [
  /^video\//,
  /^audio\//,
  /^image\/(?!svg\+xml$)/,
  /^font\/woff2?$/,
  /^application\/(zip|gzip|zstd|x-(7z|rar|xz|bzip2|tar)[-a-z0-9]*|octet-stream|pdf)$/,
  /^text\/event-stream$/,
]

Deno.test("compression compresses only the types it lists, so an unlisted media type passes through", () => {
  assertEquals(compress.excludedContentTypes, undefined)
  assertEquals(included.length > 0, true)
})

Deno.test("compression never lists video, audio, raster images, woff fonts, archives or SSE", () => {
  assertEquals(included.filter((type) => NEVER.some((re) => re.test(type))), [])
})

Deno.test("compression still compresses html, css, javascript, json, xml and svg", () => {
  for (
    const type of [
      "text/html",
      "text/css",
      "text/javascript",
      "application/javascript",
      "application/json",
      "application/xml",
      "image/svg+xml",
    ]
  ) {
    assertEquals(included.includes(type), true, type)
  }
})
