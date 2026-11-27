// Guards the optional gRPC route for agents on other machines (spy4x/rostok#504).

import { assertEquals } from "@std/assert"
import { parse } from "yaml"
import { hostsIn, renderCompose } from "../compose-interpolate.ts"

const base = { DOMAIN: "example.com", WOODPECKER_DOMAIN: "ci.example.com" }

/** The server's Traefik labels after interpolating compose.yml with `env`, as key → value. */
async function serverLabels(env: Record<string, string>): Promise<Record<string, string>> {
  const compose = parse(await renderCompose("woodpecker", env)) as {
    services: Record<string, { labels: string[] }>
  }
  const labels = compose.services["woodpecker-server"].labels
  return Object.fromEntries(
    labels.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  )
}

const grpc = "traefik.http.routers.hl-woodpecker-grpc"

Deno.test("woodpecker compose.yml: without WOODPECKER_GRPC_DOMAIN the gRPC route matches no connection", async () => {
  // ClientIP 0.0.0.0/32 is no client's address, and with no Host() Traefik asks for no certificate.
  for (const env of [base, { ...base, WOODPECKER_GRPC_DOMAIN: "" }]) {
    const labels = await serverLabels(env)
    assertEquals(labels[`${grpc}.rule`], "ClientIP(`0.0.0.0/32`)")
    assertEquals(hostsIn(await renderCompose("woodpecker", env)), ["ci.example.com"])
  }
})

Deno.test("woodpecker compose.yml: with WOODPECKER_GRPC_DOMAIN set, that host reaches gRPC over h2c on port 9000", async () => {
  const labels = await serverLabels({ ...base, WOODPECKER_GRPC_DOMAIN: "grpc.ci.example.com" })
  assertEquals(labels[`${grpc}.rule`], "Host(`grpc.ci.example.com`) || ClientIP(`0.0.0.0/32`)")
  assertEquals(labels[`${grpc}.service`], "hl-woodpecker-grpc")
  assertEquals(labels[`${grpc}.entrypoints`], "websecure")
  assertEquals(labels[`${grpc}.tls.certresolver`], "myresolver")
  assertEquals(labels["traefik.http.services.hl-woodpecker-grpc.loadbalancer.server.port"], "9000")
  assertEquals(labels["traefik.http.services.hl-woodpecker-grpc.loadbalancer.server.scheme"], "h2c")
})

Deno.test("woodpecker compose.yml: the web UI route keeps port 8000 next to the gRPC service", async () => {
  // A container with two Traefik services needs each router to name its own, or neither routes.
  const labels = await serverLabels(base)
  assertEquals(labels["traefik.http.routers.hl-woodpecker.service"], "hl-woodpecker")
  assertEquals(labels["traefik.http.services.hl-woodpecker.loadbalancer.server.port"], "8000")
})

Deno.test("woodpecker compose.yml: the agent passes the memory limit to memory and swap, and the labels", async () => {
  const agentEnv = async (env: Record<string, string>) => {
    const compose = parse(await renderCompose("woodpecker", env)) as {
      services: Record<string, { environment: string[] }>
    }
    return compose.services["woodpecker-agent"].environment.filter((e) =>
      /^WOODPECKER_(BACKEND_DOCKER_LIMIT_MEM|AGENT_LABELS)/.test(e)
    )
  }
  assertEquals(await agentEnv(base), [
    "WOODPECKER_BACKEND_DOCKER_LIMIT_MEM=0",
    "WOODPECKER_BACKEND_DOCKER_LIMIT_MEM_SWAP=0",
    "WOODPECKER_AGENT_LABELS=",
  ])
  const set = {
    ...base,
    WOODPECKER_CI_MEM_LIMIT: "6442450944",
    WOODPECKER_CI_AGENT_LABELS: "size=small",
  }
  assertEquals(await agentEnv(set), [
    "WOODPECKER_BACKEND_DOCKER_LIMIT_MEM=6442450944",
    "WOODPECKER_BACKEND_DOCKER_LIMIT_MEM_SWAP=6442450944",
    "WOODPECKER_AGENT_LABELS=size=small",
  ])
})

Deno.test("woodpecker compose.yml: agent.conf survives a recreated container, so the agent keeps its id", async () => {
  const compose = parse(
    await renderCompose("woodpecker", { ...base, VOLUMES_PATH: `/srv/volumes` }),
  ) as {
    services: Record<string, { volumes: string[] }>
  }
  assertEquals(
    compose.services["woodpecker-agent"].volumes.includes(
      `/srv/volumes/woodpecker-agent/config:/etc/woodpecker:z`,
    ),
    true,
  )
})
