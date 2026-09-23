// Tests for cli/next-steps.ts — #212 ("what do I do now?" output).

import { assertEquals } from "@std/assert"
import { join } from "@std/path"
import { buildNextSteps } from "./next-steps.ts"

async function withServerDir<T>(
  env: Record<string, string>,
  fn: (serverDir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-next-steps-" })
  try {
    const text = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n"
    await Deno.writeTextFile(join(dir, ".env"), text)
    return await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {})
  }
}

Deno.test("buildNextSteps: lists written files first", async () => {
  await withServerDir({ DOMAIN: "example.com" }, async (serverDir) => {
    const lines = await buildNextSteps({
      serverName: "home",
      serverDir,
      written: ["servers/home/.env", "servers/home/config.json"],
    })
    assertEquals(lines[0], "Wrote:")
    assertEquals(lines[1], "  servers/home/.env")
    assertEquals(lines[2], "  servers/home/config.json")
  })
})

Deno.test("buildNextSteps: always suggests `rostok deploy <server>`", async () => {
  await withServerDir({}, async (serverDir) => {
    const lines = await buildNextSteps({ serverName: "home", serverDir, written: [] })
    assertEquals(lines.includes("  rostok deploy home"), true)
  })
})

Deno.test("buildNextSteps: a missing requires dependency gets its own `stack add` line, before deploy", async () => {
  await withServerDir({}, async (serverDir) => {
    const lines = await buildNextSteps({
      serverName: "home",
      serverDir,
      written: [],
      missingRequires: ["traefik"],
    })
    const addIdx = lines.indexOf("  rostok stack add traefik -s home")
    const deployIdx = lines.indexOf("  rostok deploy home")
    assertEquals(addIdx >= 0, true)
    assertEquals(deployIdx >= 0, true)
    assertEquals(addIdx < deployIdx, true)
  })
})

Deno.test("buildNextSteps: an IP SSH_ADDRESS produces real DNS records", async () => {
  await withServerDir(
    { DOMAIN: "example.com", SSH_ADDRESS: "root@203.0.113.9" },
    async (serverDir) => {
      const lines = await buildNextSteps({ serverName: "home", serverDir, written: [] })
      assertEquals(lines.includes("  A example.com → 203.0.113.9"), true)
      assertEquals(lines.includes("  A *.example.com → 203.0.113.9"), true)
    },
  )
})

Deno.test("buildNextSteps: an alias SSH_ADDRESS falls back to a placeholder with a hint", async () => {
  await withServerDir(
    { DOMAIN: "example.com", SSH_ADDRESS: "myhomelab" },
    async (serverDir) => {
      const lines = await buildNextSteps({ serverName: "home", serverDir, written: [] })
      assertEquals(lines.includes("  A example.com → <server IP>"), true)
      assertEquals(lines.includes("  A *.example.com → <server IP>"), true)
      assertEquals(lines.some((l) => l.includes("isn't a plain IP")), true)
    },
  )
})

Deno.test("buildNextSteps: no DOMAIN in .env means no DNS section at all", async () => {
  await withServerDir({}, async (serverDir) => {
    const lines = await buildNextSteps({ serverName: "home", serverDir, written: [] })
    assertEquals(lines.some((l) => l.includes("DNS records")), false)
  })
})

Deno.test("buildNextSteps: a missing .env (server not created yet) doesn't throw", async () => {
  const dir = await Deno.makeTempDir({ prefix: "rostok-next-steps-missing-" })
  try {
    const lines = await buildNextSteps({ serverName: "home", serverDir: dir, written: [] })
    assertEquals(lines.includes("  rostok deploy home"), true)
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {})
  }
})
