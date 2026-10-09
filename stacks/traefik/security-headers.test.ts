// Guards the decisions recorded in dynamic/00-base.yml for the shared security-headers middleware
// (spy4x/rostok#354, #356). It runs on every websecure router after the router's own middlewares
// and the app, so every header it names replaces theirs.

import { assertEquals } from "@std/assert"
import { parse } from "yaml"

interface HeadersMiddleware {
  headers: {
    referrerPolicy?: string
    customResponseHeaders?: Record<string, string>
  }
}

const base = parse(
  await Deno.readTextFile(new URL("./dynamic/00-base.yml", import.meta.url)),
) as { http: { middlewares: Record<string, HeadersMiddleware> } }

const headers = base.http.middlewares["security-headers"]!.headers

/** The custom response header names, lower-cased, so a change of case cannot hide one. */
function customHeaderNames(): string[] {
  return Object.keys(headers.customResponseHeaders ?? {}).map((name) => name.toLowerCase())
}

Deno.test("security-headers lets no other site read responses: no Access-Control-Allow-Origin", () => {
  assertEquals(customHeaderNames().includes("access-control-allow-origin"), false)
})

Deno.test("security-headers keeps an app's own Referrer-Policy by setting none", () => {
  assertEquals(headers.referrerPolicy, undefined)
  assertEquals(customHeaderNames().includes("referrer-policy"), false)
})

Deno.test("security-headers isolates windows with COOP same-origin", () => {
  assertEquals(headers.customResponseHeaders?.["Cross-Origin-Opener-Policy"], "same-origin")
})

Deno.test("security-headers sets no CORP, so other sites can still show kiosk photos", () => {
  assertEquals(customHeaderNames().includes("cross-origin-resource-policy"), false)
})

Deno.test("immich-kiosk still allows every origin on its own router", async () => {
  const compose = parse(
    await Deno.readTextFile(new URL("../immich/compose.yml", import.meta.url)),
  ) as { services: { kiosk: { labels: string[] } } }
  const labels = compose.services.kiosk.labels
  const middleware = "hl-immich-kiosk-cors"
  assertEquals(
    labels.includes(
      `traefik.http.middlewares.${middleware}.headers.customresponseheaders.Access-Control-Allow-Origin=*`,
    ),
    true,
  )
  const chain = labels.find((l) =>
    l.startsWith("traefik.http.routers.hl-immich-kiosk.middlewares=")
  )
  assertEquals(chain?.split("=")[1]?.split(",").includes(`${middleware}@docker`), true)
})
