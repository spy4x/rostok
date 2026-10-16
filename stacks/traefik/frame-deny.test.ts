// X-Frame-Options: DENY is set per router, not on the websecure entrypoint (spy4x/rostok#318).
// An entrypoint middleware runs outside every router's chain, so a header it set came back after
// a router removed it, and mig's /embed could not drop it. These tests check that the entrypoint
// sends no X-Frame-Options and that every catalog router still refuses to be framed by default.

import { assertEquals } from "@std/assert"
import { parse } from "yaml"
import { interpolate } from "../compose-interpolate.ts"

interface Middleware {
  headers?: {
    frameDeny?: boolean
    customFrameOptionsValue?: string
    customResponseHeaders?: Record<string, string>
  }
  chain?: { middlewares: string[] }
}

const stacks = new URL("../", import.meta.url)

const base = parse(
  await Deno.readTextFile(new URL("./dynamic/00-base.yml", import.meta.url)),
) as { http: { middlewares: Record<string, Middleware> } }

/** The `00-base.yml` middleware a chain entry names, or undefined for one defined elsewhere. */
function baseMiddleware(name: string): Middleware | undefined {
  const [bare, provider] = name.trim().split("@")
  if (provider !== undefined && provider !== "file") return undefined
  return base.http.middlewares[bare!]
}

/** Whether a `00-base.yml` middleware, or a chain it names, sets X-Frame-Options at all. */
function setsFrameOptions(name: string): boolean {
  const m = baseMiddleware(name)
  if (!m) return false
  if (m.chain) return m.chain.middlewares.some(setsFrameOptions)
  const custom = Object.keys(m.headers?.customResponseHeaders ?? {}).map((h) => h.toLowerCase())
  return m.headers?.frameDeny === true || m.headers?.customFrameOptionsValue !== undefined ||
    custom.includes("x-frame-options")
}

/** Whether a `00-base.yml` middleware, or a chain it names, sends X-Frame-Options: DENY. */
function deniesFraming(name: string): boolean {
  const m = baseMiddleware(name)
  if (!m) return false
  if (m.chain) return m.chain.middlewares.some(deniesFraming)
  return m.headers?.frameDeny === true
}

/** The Traefik labels of every service in a compose file, interpolated with `env`. */
async function labelsOf(file: URL, env: Record<string, string>): Promise<string[]> {
  const compose = parse(await Deno.readTextFile(file)) as {
    services?: Record<string, { labels?: string[] | Record<string, string> }>
  }
  return Object.values(compose.services ?? {}).flatMap((service) => {
    const labels = service.labels ?? []
    const list = Array.isArray(labels)
      ? labels
      : Object.entries(labels).map(([key, value]) => `${key}=${value}`)
    return list.map((label) => interpolate(label, env))
  })
}

/** Each router a label list defines (it has a `rule`), with its middleware chain. */
function routerChains(labels: string[]): Map<string, string[]> {
  const chains = new Map<string, string[]>()
  for (const label of labels) {
    const rule = label.match(/^traefik\.http\.routers\.([^.]*)\.rule=/)
    if (rule) chains.set(rule[1]!, chains.get(rule[1]!) ?? [])
    const mw = label.match(/^traefik\.http\.routers\.([^.]*)\.middlewares=(.*)$/)
    if (mw) chains.set(mw[1]!, mw[2]!.split(",").map((m) => m.trim()).filter(Boolean))
  }
  return chains
}

/** Every compose file of every catalog stack. */
async function composeFiles(): Promise<URL[]> {
  const files: URL[] = []
  for await (const dir of Deno.readDir(stacks)) {
    if (!dir.isDirectory) continue
    for await (const f of Deno.readDir(new URL(`${dir.name}/`, stacks))) {
      if (f.isFile && /^compose.*\.ya?ml$/.test(f.name)) {
        files.push(new URL(`${dir.name}/${f.name}`, stacks))
      }
    }
  }
  return files
}

Deno.test("the websecure entrypoint sends no X-Frame-Options, so a router can leave it out", async () => {
  const compose = parse(
    await Deno.readTextFile(new URL("./compose.yml", import.meta.url)),
  ) as { services: { traefik: { command: string[] } } }
  const flag = "--entrypoints.websecure.http.middlewares="
  const chain = compose.services.traefik.command.find((c) => c.startsWith(flag))!
    .slice(flag.length).split(",")
  assertEquals(chain, ["security-headers-base@file", "compression@file"])
  assertEquals(chain.filter(setsFrameOptions), [])
})

Deno.test("frame-deny and security-headers both send X-Frame-Options: DENY", () => {
  assertEquals(deniesFraming("frame-deny@file"), true)
  assertEquals(deniesFraming("security-headers@file"), true)
  assertEquals(base.http.middlewares["security-headers"]?.chain?.middlewares, [
    "security-headers-base",
    "frame-deny",
  ])
})

Deno.test("every catalog router refuses to be framed with its default middlewares", async () => {
  const files = await composeFiles()
  const framable: string[] = []
  let routers = 0
  for (const file of files) {
    for (const [router, chain] of routerChains(await labelsOf(file, {}))) {
      routers++
      if (!chain.some(deniesFraming)) {
        framable.push(`${file.pathname.split("/stacks/")[1]} ${router}`)
      }
    }
  }
  assertEquals(framable, [])
  // A parser that found no router would pass the check above; the catalog has dozens.
  assertEquals(routers > 40, true, `only ${routers} routers found`)
})

Deno.test("mig: an embed chain without frame-deny frees /embed while the rest of the host keeps DENY", async () => {
  const file = new URL("mig/compose.yml", stacks)
  const embedding = {
    MIG_MIDDLEWARES: "security-headers@file,compression@file,robots-deny@file",
    MIG_EMBED_MIDDLEWARES: "mig-frame-ancestors@file,compression@file,robots-deny@file",
  }
  const chains = routerChains(await labelsOf(file, embedding))
  assertEquals(chains.get("hl-mig")?.some(deniesFraming), true)
  assertEquals(chains.get("hl-mig-embed")?.some(setsFrameOptions), false)
  // Without MIG_EMBED_MIDDLEWARES, /embed follows the main chain and refuses to be framed.
  const plain = routerChains(await labelsOf(file, {}))
  assertEquals(plain.get("hl-mig-embed")?.some(deniesFraming), true)
})
