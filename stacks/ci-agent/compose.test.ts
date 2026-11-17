// Guards the agent-only stack for a second machine (spy4x/rostok#504).

import { assertEquals, assertThrows } from "@std/assert"
import { parse } from "yaml"
import { interpolate, renderCompose } from "../compose-interpolate.ts"

interface Service {
  container_name: string
  user: string
  group_add: string[]
  environment: string[]
  volumes: string[]
  security_opt: string[]
  restart: string
  labels?: string[]
  depends_on?: unknown
}

const env: Record<string, string> = {
  VOLUMES_PATH: "/srv/volumes",
  CI_AGENT_GRPC_DOMAIN: "grpc.ci.example.com",
  CI_AGENT_SECRET: "test-secret",
}

/** Services of a stack's compose.yml as written, before interpolation. */
async function rawServices(stack: string): Promise<Record<string, Service>> {
  const text = await Deno.readTextFile(new URL(`../${stack}/compose.yml`, import.meta.url))
  return (parse(text) as { services: Record<string, Service> }).services
}

/** The agent service after interpolating compose.yml with `vars`. */
async function agent(vars: Record<string, string>): Promise<Service> {
  const compose = parse(await renderCompose("ci-agent", vars)) as {
    services: Record<string, Service>
  }
  return compose.services["ci-agent"]
}

Deno.test("ci-agent compose.yml: connects to the gRPC host over TLS on 443 with the shared secret", async () => {
  const service = await agent(env)
  assertEquals(
    service.environment.filter((e) => /^WOODPECKER_(SERVER|GRPC_SECURE|AGENT_SECRET)=/.test(e)),
    [
      "WOODPECKER_SERVER=grpc.ci.example.com:443",
      "WOODPECKER_GRPC_SECURE=true",
      "WOODPECKER_AGENT_SECRET=test-secret",
    ],
  )
  assertEquals(service.environment.includes("WOODPECKER_MAX_WORKFLOWS=4"), true)
})

Deno.test("ci-agent compose.yml: deploy stops while the gRPC host or the secret is empty", async () => {
  const text = await Deno.readTextFile(new URL("./compose.yml", import.meta.url))
  for (const key of ["CI_AGENT_GRPC_DOMAIN", "CI_AGENT_SECRET"]) {
    assertThrows(() => interpolate(text, { ...env, [key]: "" }), Error, key)
    const rest = { ...env }
    delete rest[key]
    assertThrows(() => interpolate(text, rest), Error, key)
  }
})

Deno.test("ci-agent compose.yml: Docker access is exactly the woodpecker stack's agent's", async () => {
  const mine = (await rawServices("ci-agent"))["ci-agent"]
  const theirs = (await rawServices("woodpecker"))["woodpecker-agent"]
  const sock = (s: Service) => s.volumes.filter((v) => v.includes("docker.sock"))
  assertEquals(sock(mine), sock(theirs))
  assertEquals(mine.user, theirs.user)
  assertEquals(mine.group_add, theirs.group_add)
  assertEquals(mine.security_opt, theirs.security_opt)
})

Deno.test("ci-agent compose.yml: agent.conf survives a restart, so the agent keeps its id", async () => {
  const service = await agent(env)
  assertEquals(
    service.volumes.includes("/srv/volumes/ci-agent:/etc/woodpecker:z"),
    true,
  )
  assertEquals(service.restart, "unless-stopped")
})

Deno.test("ci-agent compose.yml: can share a server with the woodpecker stack and needs no Traefik", async () => {
  // Deploy merges every stack's compose.yml into one project: a shared service name would merge
  // the two agents, and a shared container name would stop one of them starting.
  const mine = await rawServices("ci-agent")
  const theirs = await rawServices("woodpecker")
  assertEquals(Object.keys(mine).filter((name) => name in theirs), [])
  const names = new Set(Object.values(theirs).map((s) => s.container_name))
  assertEquals(Object.values(mine).filter((s) => names.has(s.container_name)), [])
  assertEquals(mine["ci-agent"].labels, undefined)
  assertEquals(mine["ci-agent"].depends_on, undefined)
})

/** The step limit and label lines of the agent's environment. */
const limits = (s: Service) =>
  s.environment.filter((e) => /^WOODPECKER_(BACKEND_DOCKER_LIMIT_MEM|AGENT_LABELS)/.test(e))

Deno.test("ci-agent compose.yml: no memory limit and no labels unless set", async () => {
  assertEquals(limits(await agent(env)), [
    "WOODPECKER_BACKEND_DOCKER_LIMIT_MEM=0",
    "WOODPECKER_BACKEND_DOCKER_LIMIT_MEM_SWAP=0",
    "WOODPECKER_AGENT_LABELS=",
  ])
})

Deno.test("ci-agent compose.yml: passes the memory limit to memory and swap, and the labels", async () => {
  const set = { ...env, CI_AGENT_MEM_LIMIT: "8589934592", CI_AGENT_AGENT_LABELS: "!size=small" }
  assertEquals(limits(await agent(set)), [
    "WOODPECKER_BACKEND_DOCKER_LIMIT_MEM=8589934592",
    "WOODPECKER_BACKEND_DOCKER_LIMIT_MEM_SWAP=8589934592",
    "WOODPECKER_AGENT_LABELS=!size=small",
  ])
})
