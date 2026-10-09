// Guards how stacks/traefik/compose.yml exposes the Traefik API and where Traefik sits on the
// proxy network (spy4x/rostok#356).

import { assertEquals } from "@std/assert"
import { parse } from "yaml"

import meta from "./+meta.ts"

interface Service {
  command: string[]
  healthcheck: { test: string[] }
  labels: string[]
  networks: Record<string, { ipv4_address?: string }>
}

const traefik = (parse(
  await Deno.readTextFile(new URL("./compose.yml", import.meta.url)),
) as { services: { traefik: Service } }).services.traefik

Deno.test("traefik: the API is not served unauthenticated on port 8080 to the proxy network", () => {
  assertEquals(traefik.command.filter((flag) => flag.startsWith("--api")), ["--api=true"])
  assertEquals(traefik.command.includes("--ping=true"), true)
  assertEquals(traefik.healthcheck.test.at(-1), "http://localhost:8080/ping")
})

Deno.test("traefik: the dashboard is served only through its router, behind dashboard-auth", () => {
  const router = "traefik.http.routers.hl-traefik."
  assertEquals(traefik.labels.includes(`${router}service=api@internal`), true)
  const chain = traefik.labels.find((l) => l.startsWith(`${router}middlewares=`))
  assertEquals(chain?.split("=")[1]?.split(",")[0], "dashboard-auth@file")
  assertEquals(traefik.labels.some((l) => l.includes("loadbalancer.server.port=8080")), false)
})

Deno.test("traefik: TRAEFIK_PROXY_IP is an optional fixed address on the proxy network", () => {
  assertEquals(traefik.networks.proxy?.ipv4_address, "${TRAEFIK_PROXY_IP:-}")
  const v = meta.variables.find((v) => v.key === "TRAEFIK_PROXY_IP")
  assertEquals(v?.required, false)
  assertEquals(v?.default, "")
})

Deno.test("traefik: /dashboard without the slash redirects to /dashboard/", () => {
  const prefix = "traefik.http.middlewares.hl-traefik-dashboard-slash.redirectregex."
  const value = (key: string) =>
    traefik.labels.find((l) => l.startsWith(`${prefix}${key}=`))?.slice(
      prefix.length + key.length + 1,
    )
  // Compose turns $$ into $, so these are the strings Traefik receives once unescaped.
  const regex = new RegExp(value("regex")!.replaceAll("$$", "$"))
  const replacement = value("replacement")!.replaceAll("$$", "$")
  const url = "https://proxy.example.com/dashboard"
  assertEquals(url.replace(regex, replacement), "https://proxy.example.com/dashboard/")
  assertEquals(
    "https://proxy.example.com/dashboard/".replace(regex, replacement),
    "https://proxy.example.com/dashboard/",
  )
  const chain = traefik.labels.find((l) =>
    l.startsWith("traefik.http.routers.hl-traefik.middlewares=")
  )
  assertEquals(chain?.split("=")[1]?.split(",").includes("hl-traefik-dashboard-slash@docker"), true)
})
