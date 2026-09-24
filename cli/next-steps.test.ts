// Tests for cli/next-steps.ts — #212 ("what do I do now?" output).

import { assertEquals } from "@std/assert"
import { join } from "@std/path"
import { buildNextSteps } from "./next-steps.ts"

/**
 * Sets up `<tmp>/servers/<name>/` as the cwd-relative server dir (chdir
 * into `<tmp>` for the duration of `fn`) so relative "Wrote:" paths like
 * `servers/home/.env` resolve against a real file, matching how the
 * wizard/`stack add` actually call buildNextSteps from the project root.
 */
async function withServerDir<T>(
  opts: {
    env?: Record<string, string>
    stacks?: string[]
    serverName?: string
  },
  fn: (serverDir: string, relEnvPath: string, relConfigPath: string) => Promise<T>,
): Promise<T> {
  const name = opts.serverName ?? "home"
  const root = await Deno.makeTempDir({ prefix: "rostok-next-steps-" })
  const originalCwd = Deno.cwd()
  try {
    const serverDir = join(root, "servers", name)
    await Deno.mkdir(serverDir, { recursive: true })
    if (opts.env) {
      const text = Object.entries(opts.env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n"
      await Deno.writeTextFile(join(serverDir, ".env"), text)
    }
    if (opts.stacks) {
      await Deno.writeTextFile(
        join(serverDir, "config.json"),
        JSON.stringify({ stacks: opts.stacks.map((s) => ({ name: s })) }, null, 2) + "\n",
      )
    }
    Deno.chdir(root)
    return await fn(serverDir, `servers/${name}/.env`, `servers/${name}/config.json`)
  } finally {
    Deno.chdir(originalCwd)
    await Deno.remove(root, { recursive: true }).catch(() => {})
  }
}

Deno.test("buildNextSteps: lists only the written files that actually exist", async () => {
  await withServerDir(
    { env: { DOMAIN: "example.com" }, stacks: ["traefik"] },
    async (serverDir, relEnv, relConfig) => {
      const lines = await buildNextSteps({
        serverName: "home",
        serverDir,
        written: [relEnv, relConfig],
      })
      assertEquals(lines[0], "Wrote:")
      assertEquals(lines[1], `  ${relEnv}`)
      assertEquals(lines[2], `  ${relConfig}`)
    },
  )
})

// #212 review fix — a caller that always names both `.env` and
// `config.json` in `written` shouldn't claim `config.json` was written
// when the wizard's stack step was skipped (no stack ever added, so the
// file never exists).
Deno.test("buildNextSteps: omits a written path that doesn't exist on disk (e.g. config.json never created)", async () => {
  await withServerDir(
    { env: { DOMAIN: "example.com" } },
    async (serverDir, relEnv, relConfig) => {
      const lines = await buildNextSteps({
        serverName: "home",
        serverDir,
        written: [relEnv, relConfig], // config.json was never written
      })
      assertEquals(lines[0], "Wrote:")
      assertEquals(lines.includes(`  ${relEnv}`), true)
      assertEquals(lines.includes(`  ${relConfig}`), false)
    },
  )
})

Deno.test("buildNextSteps: no Wrote: section at all when nothing in `written` exists", async () => {
  await withServerDir({}, async (serverDir) => {
    const lines = await buildNextSteps({
      serverName: "home",
      serverDir,
      written: ["servers/home/.env", "servers/home/config.json"],
    })
    assertEquals(lines.includes("Wrote:"), false)
  })
})

Deno.test("buildNextSteps: suggests `rostok deploy <server>` when at least one stack is configured", async () => {
  await withServerDir({ stacks: ["traefik"] }, async (serverDir) => {
    const lines = await buildNextSteps({ serverName: "home", serverDir, written: [] })
    assertEquals(lines.includes("  rostok deploy home"), true)
  })
})

// #212 review fix — the wizard with no stacks picked (or `stack add`
// never having run at all) means config.json is missing or empty;
// deploying would deploy nothing, so the suggestion is to add a stack
// instead of the (useless) deploy command.
Deno.test("buildNextSteps: with no stacks configured, suggests `stack add` instead of `deploy`", async () => {
  await withServerDir({}, async (serverDir) => {
    const lines = await buildNextSteps({ serverName: "home", serverDir, written: [] })
    assertEquals(lines.includes("  rostok stack add <name> -s home"), true)
    assertEquals(lines.includes("  rostok deploy home"), false)
  })
})

Deno.test("buildNextSteps: an empty config.json (stacks: []) also counts as no stacks configured", async () => {
  await withServerDir({ stacks: [] }, async (serverDir) => {
    const lines = await buildNextSteps({ serverName: "home", serverDir, written: [] })
    assertEquals(lines.includes("  rostok stack add <name> -s home"), true)
    assertEquals(lines.includes("  rostok deploy home"), false)
  })
})

Deno.test("buildNextSteps: a missing requires dependency gets its own `stack add` line, before deploy", async () => {
  await withServerDir({ stacks: ["web"] }, async (serverDir) => {
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

// ─────────────────────────────────────────────────────────────────────
// DNS records — IPv4, IPv4:port, bare IPv6, [v6]:port and an alias.
// Rules mirror #228's deploy-side SSH_ADDRESS host parsing: a bracketed
// IPv6 literal may carry a :port (stripped); a bare IPv6 literal never
// does, so nothing is stripped from it; IPv4/alias may carry a single
// :port (stripped).
// ─────────────────────────────────────────────────────────────────────

Deno.test("buildNextSteps: a plain IPv4 SSH_ADDRESS produces A records", async () => {
  await withServerDir(
    { env: { DOMAIN: "example.com", SSH_ADDRESS: "root@203.0.113.9" }, stacks: ["traefik"] },
    async (serverDir) => {
      const lines = await buildNextSteps({ serverName: "home", serverDir, written: [] })
      assertEquals(lines.includes("  A example.com → 203.0.113.9"), true)
      assertEquals(lines.includes("  A *.example.com → 203.0.113.9"), true)
    },
  )
})

Deno.test("buildNextSteps: an IPv4:port SSH_ADDRESS strips the port, still an A record", async () => {
  await withServerDir(
    { env: { DOMAIN: "example.com", SSH_ADDRESS: "root@203.0.113.9:2222" }, stacks: ["traefik"] },
    async (serverDir) => {
      const lines = await buildNextSteps({ serverName: "home", serverDir, written: [] })
      assertEquals(lines.includes("  A example.com → 203.0.113.9"), true)
      assertEquals(lines.includes("  A *.example.com → 203.0.113.9"), true)
    },
  )
})

Deno.test("buildNextSteps: a bare IPv6 SSH_ADDRESS (no brackets, no port) produces AAAA records", async () => {
  await withServerDir(
    {
      env: { DOMAIN: "example.com", SSH_ADDRESS: "root@2001:db8::1" },
      stacks: ["traefik"],
    },
    async (serverDir) => {
      const lines = await buildNextSteps({ serverName: "home", serverDir, written: [] })
      // Nothing must be stripped from a bare IPv6 literal — "::1" is part
      // of the address, not a port.
      assertEquals(lines.includes("  AAAA example.com → 2001:db8::1"), true)
      assertEquals(lines.includes("  AAAA *.example.com → 2001:db8::1"), true)
    },
  )
})

Deno.test("buildNextSteps: a bracketed [IPv6]:port SSH_ADDRESS strips the port, produces AAAA records", async () => {
  await withServerDir(
    {
      env: { DOMAIN: "example.com", SSH_ADDRESS: "root@[2001:db8::1]:2222" },
      stacks: ["traefik"],
    },
    async (serverDir) => {
      const lines = await buildNextSteps({ serverName: "home", serverDir, written: [] })
      assertEquals(lines.includes("  AAAA example.com → 2001:db8::1"), true)
      assertEquals(lines.includes("  AAAA *.example.com → 2001:db8::1"), true)
    },
  )
})

Deno.test("buildNextSteps: an alias SSH_ADDRESS falls back to a placeholder with a hint", async () => {
  await withServerDir(
    { env: { DOMAIN: "example.com", SSH_ADDRESS: "myhomelab" }, stacks: ["traefik"] },
    async (serverDir) => {
      const lines = await buildNextSteps({ serverName: "home", serverDir, written: [] })
      assertEquals(lines.includes("  A example.com → <server IP>"), true)
      assertEquals(lines.includes("  A *.example.com → <server IP>"), true)
      assertEquals(lines.some((l) => l.includes("isn't a plain IP")), true)
      assertEquals(lines.some((l) => l.includes("undefined")), false)
    },
  )
})

// Security review — a hand-edited SSH_ADDRESS carrying a control
// character must not reach this hint text unescaped: the value read
// from .env is echoed straight into the "(SSH_ADDRESS ... isn't a
// plain IP" hint whenever parseSshAddress rejects it.
Deno.test("buildNextSteps: strips control characters from an SSH_ADDRESS parseSshAddress rejects", async () => {
  await withServerDir(
    { env: { DOMAIN: "example.com", SSH_ADDRESS: "myhomelab\x07evil" }, stacks: ["traefik"] },
    async (serverDir) => {
      const lines = await buildNextSteps({ serverName: "home", serverDir, written: [] })
      assertEquals(lines.some((l) => l.includes("\x07")), false, lines.join("\n"))
      assertEquals(lines.some((l) => l.includes("myhomelabevil")), true, lines.join("\n"))
    },
  )
})

// #212 review fix — SSH_ADDRESS entirely unset (not just non-IP) used to
// interpolate the JS value `undefined` into the hint text verbatim
// ("SSH_ADDRESS \"undefined\" isn't a plain IP").
Deno.test("buildNextSteps: a missing SSH_ADDRESS gets its own hint, never the literal word 'undefined'", async () => {
  await withServerDir(
    { env: { DOMAIN: "example.com" }, stacks: ["traefik"] },
    async (serverDir) => {
      const lines = await buildNextSteps({ serverName: "home", serverDir, written: [] })
      assertEquals(lines.includes("  A example.com → <server IP>"), true)
      assertEquals(lines.some((l) => l.includes("undefined")), false)
      assertEquals(lines.some((l) => l.includes("isn't set yet")), true)
    },
  )
})

Deno.test("buildNextSteps: no DOMAIN in .env means no DNS section at all", async () => {
  await withServerDir({ stacks: ["traefik"] }, async (serverDir) => {
    const lines = await buildNextSteps({ serverName: "home", serverDir, written: [] })
    assertEquals(lines.some((l) => l.includes("DNS records")), false)
  })
})

Deno.test("buildNextSteps: a missing .env and config.json (server not created yet) doesn't throw", async () => {
  const dir = await Deno.makeTempDir({ prefix: "rostok-next-steps-missing-" })
  try {
    const lines = await buildNextSteps({ serverName: "home", serverDir: dir, written: [] })
    assertEquals(lines.includes("  rostok stack add <name> -s home"), true)
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {})
  }
})
