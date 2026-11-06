// Tests for cli/commands/llms.ts — `rostok llms`, the service map for AI agents.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import type { CatalogEntry } from "../catalog.ts"
import { UserError } from "../errors.ts"
import { collectServices, renderLlms, runLlms } from "./llms.ts"

const CATALOG = [
  { name: "ntfy", meta: { name: "ntfy", description: "Push notifications", variables: [] } },
  { name: "gatus", meta: { name: "gatus", description: "Health checks", variables: [] } },
] as CatalogEntry[]

async function withProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-commands-llms-" })
  try {
    await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

async function writeServer(
  dir: string,
  server: string,
  stacks: Record<string, unknown>[],
  env: string | undefined,
): Promise<void> {
  const serverDir = join(dir, "servers", server)
  await Deno.mkdir(serverDir, { recursive: true })
  await Deno.writeTextFile(join(serverDir, "config.json"), JSON.stringify({ stacks }))
  if (env !== undefined) await Deno.writeTextFile(join(serverDir, ".env"), env)
}

Deno.test("llms: groups stacks by aiCanUse into may use, ask first and must not use", async () => {
  await withProject(async (dir) => {
    await writeServer(dir, "home", [
      { name: "ntfy", aiCanUse: true, aiNotes: "topic agents" },
      { name: "gatus" },
      { name: "traefik", aiCanUse: false },
    ], "SERVER_NAME=home\nDOMAIN=example.com\n")
    const text = renderLlms(await collectServices(dir, CATALOG))
    // Each section's title and the stacks listed under it, in file order.
    const sections = text.split("\n## ").slice(1).map((section) => [
      section.split("\n")[0],
      ...[...section.matchAll(/^- \*\*([a-z0-9_-]+)\*\*/gm)].map((m) => m[1]),
    ])
    assertEquals(sections, [
      ["Agents may use", "ntfy"],
      ["Ask the owner before using", "gatus"],
      ["Agents must not use", "traefik"],
    ])
    assertStringIncludes(text, "Push notifications — Notes: topic agents")
  })
})

Deno.test("llms: resolves ${SERVER_NAME} and ${DOMAIN} in a stack's own _DOMAIN keys only", async () => {
  await withProject(async (dir) => {
    await Deno.writeTextFile(join(dir, ".env.root"), "DOMAIN=example.com\n")
    await writeServer(
      dir,
      "home",
      [{ name: "ntfy", aiCanUse: true }],
      "SERVER_NAME=home\nNTFY_DOMAIN=ntfy-${SERVER_NAME}.${DOMAIN}\nNTFY_TOKEN=s3cret\n" +
        "GATUS_DOMAIN=status.example.com\n",
    )
    const [service] = await collectServices(dir, CATALOG)
    assertEquals(service.urls, ["https://ntfy-home.example.com"])
    assertEquals(renderLlms([service]).includes("s3cret"), false)
  })
})

Deno.test("llms: a _DOMAIN value never resolves a reference to another .env key", async () => {
  await withProject(async (dir) => {
    await writeServer(
      dir,
      "home",
      [{ name: "ntfy" }],
      "DOMAIN=example.com\nNTFY_TOKEN=s3cret\nNTFY_DOMAIN=${NTFY_TOKEN}.example.com\n",
    )
    const services = await collectServices(dir, CATALOG)
    assertEquals(services[0].urls, ["https://${NTFY_TOKEN}.example.com"])
    assertEquals(renderLlms(services).includes("s3cret"), false)
  })
})

Deno.test("llms: the server .env wins over .env.root", async () => {
  await withProject(async (dir) => {
    await Deno.writeTextFile(join(dir, ".env.root"), "DOMAIN=root.example.com\n")
    await writeServer(
      dir,
      "home",
      [{ name: "ntfy" }],
      "DOMAIN=example.com\nNTFY_DOMAIN=n.${DOMAIN}\n",
    )
    const [service] = await collectServices(dir, CATALOG)
    assertEquals(service.urls, ["https://n.example.com"])
  })
})

Deno.test("llms: a server without a plaintext .env fails and names rostok env decrypt", async () => {
  await withProject(async (dir) => {
    await writeServer(dir, "home", [{ name: "ntfy" }], undefined)
    await assertRejects(() => collectServices(dir, CATALOG), UserError, "rostok env decrypt")
  })
})

Deno.test("llms --check: fails on a stale llms.txt, passes on a fresh one, writes nothing", async () => {
  await withProject(async (dir) => {
    await writeServer(dir, "home", [{ name: "ntfy", aiCanUse: true }], "DOMAIN=example.com\n")
    const path = join(dir, "llms.txt")
    await assertRejects(() => runLlms(dir, true), UserError, "out of date")
    await Deno.writeTextFile(path, "stale\n")
    await assertRejects(() => runLlms(dir, true), UserError, "out of date")
    assertEquals(await Deno.readTextFile(path), "stale\n")
    await runLlms(dir, false)
    const fresh = await Deno.readTextFile(path)
    assertEquals(await runLlms(dir, true), "llms.txt is up to date.")
    await runLlms(dir, false)
    assertEquals(await Deno.readTextFile(path), fresh)
  })
})

Deno.test("llms: rejects a non-boolean aiCanUse, naming stack, field and file", async () => {
  await withProject(async (dir) => {
    await writeServer(dir, "home", [{ name: "ntfy", aiCanUse: "yes" }], "DOMAIN=example.com\n")
    const err = await assertRejects(() => collectServices(dir, CATALOG), UserError)
    assertStringIncludes(err.message, `stack "ntfy"`)
    assertStringIncludes(err.message, `"aiCanUse" must be a boolean`)
    assertStringIncludes(err.message, join("servers", "home", "config.json"))
  })
})

Deno.test("llms: lists services by server name, then stack name", async () => {
  await withProject(async (dir) => {
    await writeServer(dir, "work", [{ name: "ntfy" }], "DOMAIN=example.com\n")
    await writeServer(dir, "home", [{ name: "ntfy" }, { name: "gatus" }], "DOMAIN=example.com\n")
    const order = (await collectServices(dir, CATALOG)).map((s) => `${s.server}/${s.stack}`)
    assertEquals(order, ["home/gatus", "home/ntfy", "work/ntfy"])
  })
})
