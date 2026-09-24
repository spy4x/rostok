// Tests for cli/stack-remove.ts — #225.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { UserError } from "./errors.ts"
import { readEnvFile } from "./env-files.ts"
import { readServerConfig, stackAdd } from "./stack-add.ts"
import { stackRemove } from "./stack-remove.ts"

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-stack-remove-" })
  try {
    return await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {})
  }
}

/** Fixture catalog: traefik (declares CONTACT_EMAIL, a server key) + web (requires traefik). */
async function writeTraefikWebCatalog(catalogDir: string): Promise<void> {
  await Deno.mkdir(join(catalogDir, "traefik"), { recursive: true })
  await Deno.writeTextFile(
    join(catalogDir, "traefik", "+meta.ts"),
    `import type { StackMeta } from "@rostok/cli"
export default {
  name: "traefik",
  description: "reverse proxy",
  variables: [
    { key: "TRAEFIK_IMAGE_TAG", default: "3.0", required: false },
    { key: "CONTACT_EMAIL", default: "a@example.com", required: true },
  ],
} satisfies StackMeta
`,
  )
  await Deno.mkdir(join(catalogDir, "web"), { recursive: true })
  await Deno.writeTextFile(
    join(catalogDir, "web", "+meta.ts"),
    `import type { StackMeta } from "@rostok/cli"
export default {
  name: "web",
  description: "a web stack",
  requires: ["traefik"],
  variables: [{ key: "WEB_DOMAIN", default: "web.\${DOMAIN}", required: true }],
} satisfies StackMeta
`,
  )
}

/** Fixture catalog: one stack, no requires, one of its own secret keys. */
async function writeLibrespeedCatalog(catalogDir: string): Promise<void> {
  await Deno.mkdir(join(catalogDir, "librespeed"), { recursive: true })
  await Deno.writeTextFile(
    join(catalogDir, "librespeed", "+meta.ts"),
    `import type { StackMeta } from "@rostok/cli"
export default {
  name: "librespeed",
  description: "speed test",
  variables: [
    { key: "LIBRESPEED_PASSWORD", default: "secret", required: true },
    { key: "LIBRESPEED_DOMAIN", default: "speed.\${DOMAIN}", required: true },
  ],
} satisfies StackMeta
`,
  )
}

async function seedServer(dir: string, name: string, env: Record<string, string>): Promise<void> {
  await Deno.mkdir(join(dir, "servers", name), { recursive: true })
  const text = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n"
  await Deno.writeTextFile(join(dir, "servers", name, ".env"), text)
}

// ─────────────────────────────────────────────────────────────────────
// Missing server / missing stack.
// ─────────────────────────────────────────────────────────────────────

Deno.test("stack remove: missing server fails with a UserError", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await assertRejects(
      () => stackRemove("librespeed", "ghost", { cwd: dir, catalogDir }),
      UserError,
    )
  })
})

Deno.test("stack remove: a stack not installed on the server fails with a UserError", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com" })
    await Deno.writeTextFile(
      join(dir, "servers", "home", "config.json"),
      JSON.stringify({ stacks: [] }),
    )
    const err = await assertRejects(
      () => stackRemove("librespeed", "home", { cwd: dir, catalogDir }),
      UserError,
    )
    assertStringIncludes(err.message, "not installed on 'home'")
  })
})

// ─────────────────────────────────────────────────────────────────────
// Config.json removal + own env keys (drop-env flag, confirm, notice).
// ─────────────────────────────────────────────────────────────────────

async function addLibrespeed(dir: string, catalogDir: string): Promise<void> {
  await stackAdd("librespeed", "home", { cwd: dir, catalogDir, nonInteractive: true })
}

Deno.test("stack remove --drop-env: removes from config.json and drops its own env keys, without asking", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com" })
    await addLibrespeed(dir, catalogDir)

    const result = await stackRemove("librespeed", "home", {
      cwd: dir,
      catalogDir,
      dropEnv: true,
      confirmFn: () => {
        throw new Error("must not ask when --drop-env is set")
      },
    })
    assertEquals(result.droppedKeys.sort(), ["LIBRESPEED_DOMAIN", "LIBRESPEED_PASSWORD"])

    const cfg = await readServerConfig(join(dir, "servers", "home"))
    assertEquals(cfg.stacks.some((s) => s.name === "librespeed"), false)

    const entries = await readEnvFile(join(dir, "servers", "home", ".env"))
    assertEquals(entries.some((e) => e.key.startsWith("LIBRESPEED_")), false)
  })
})

Deno.test("stack remove -n (non-interactive, no --drop-env): removes from config.json, leaves env keys with a notice", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com" })
    await addLibrespeed(dir, catalogDir)

    const lines: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(" "))
    let result
    try {
      result = await stackRemove("librespeed", "home", {
        cwd: dir,
        catalogDir,
        nonInteractive: true,
      })
    } finally {
      console.log = originalLog
    }
    assertEquals(result.droppedKeys, [])
    assertEquals(result.keptOwnKeys.sort(), ["LIBRESPEED_DOMAIN", "LIBRESPEED_PASSWORD"])
    assertEquals(lines.some((l) => l.includes("--drop-env")), true, lines.join("\n"))

    const cfg = await readServerConfig(join(dir, "servers", "home"))
    assertEquals(cfg.stacks.some((s) => s.name === "librespeed"), false)

    const entries = await readEnvFile(join(dir, "servers", "home", ".env"))
    assertEquals(entries.some((e) => e.key === "LIBRESPEED_PASSWORD"), true)
  })
})

Deno.test("stack remove interactive: confirming drops env keys, declining leaves them", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeLibrespeedCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com" })
    await addLibrespeed(dir, catalogDir)

    const declined = await stackRemove("librespeed", "home", {
      cwd: dir,
      catalogDir,
      confirmFn: () => Promise.resolve(false),
    })
    assertEquals(declined.droppedKeys, [])
    let entries = await readEnvFile(join(dir, "servers", "home", ".env"))
    assertEquals(entries.some((e) => e.key === "LIBRESPEED_PASSWORD"), true)

    // Re-add (config.json entry was already dropped by the call above)
    // so a second removal has something to confirm against.
    await addLibrespeed(dir, catalogDir)
    const confirmed = await stackRemove("librespeed", "home", {
      cwd: dir,
      catalogDir,
      confirmFn: () => Promise.resolve(true),
    })
    assertEquals(confirmed.droppedKeys.sort(), ["LIBRESPEED_DOMAIN", "LIBRESPEED_PASSWORD"])
    entries = await readEnvFile(join(dir, "servers", "home", ".env"))
    assertEquals(entries.some((e) => e.key === "LIBRESPEED_PASSWORD"), false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// #225 — a shared server-level key survives removal, even when this
// stack's own +meta.ts declares it (traefik's CONTACT_EMAIL).
// ─────────────────────────────────────────────────────────────────────

Deno.test("stack remove: a shared server-level key (CONTACT_EMAIL) survives, even though the stack declares it", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeTraefikWebCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com", CONTACT_EMAIL: "ops@example.com" })
    await stackAdd("traefik", "home", { cwd: dir, catalogDir, nonInteractive: true })

    const result = await stackRemove("traefik", "home", { cwd: dir, catalogDir, dropEnv: true })
    // Only TRAEFIK_IMAGE_TAG is a genuine stack-owned key here —
    // CONTACT_EMAIL is a server key (isServerKey) even though traefik's
    // own +meta.ts also declares it.
    assertEquals(result.droppedKeys, ["TRAEFIK_IMAGE_TAG"])

    const entries = await readEnvFile(join(dir, "servers", "home", ".env"))
    const byKey = new Map(entries.map((e) => [e.key, e.value]))
    assertEquals(byKey.get("CONTACT_EMAIL"), "ops@example.com")
    assertEquals(byKey.get("DOMAIN"), "example.com")
  })
})

// ─────────────────────────────────────────────────────────────────────
// requires refusal (#225) — refuses removing a stack another installed
// stack still requires, unless --force.
// ─────────────────────────────────────────────────────────────────────

Deno.test("stack remove: refuses to remove a stack another installed stack requires", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeTraefikWebCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com", CONTACT_EMAIL: "ops@example.com" })
    await stackAdd("traefik", "home", { cwd: dir, catalogDir, nonInteractive: true })
    await stackAdd("web", "home", { cwd: dir, catalogDir, nonInteractive: true })

    const err = await assertRejects(
      () =>
        stackRemove("traefik", "home", {
          cwd: dir,
          catalogDir,
          // The refusal must fire before ever asking about env keys —
          // a confirmFn that throws proves it.
          confirmFn: () => {
            throw new Error("must not ask — the requires refusal should fire first")
          },
        }),
      UserError,
    )
    assertStringIncludes(err.message, "required by web")
    assertStringIncludes(err.message, "--force")

    // Nothing removed — config.json still lists both.
    const cfg = await readServerConfig(join(dir, "servers", "home"))
    assertEquals(cfg.stacks.map((s) => s.name).sort(), ["traefik", "web"])
  })
})

Deno.test("stack remove --force: removes a required stack anyway", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeTraefikWebCatalog(catalogDir)
    await seedServer(dir, "home", { DOMAIN: "example.com", CONTACT_EMAIL: "ops@example.com" })
    await stackAdd("traefik", "home", { cwd: dir, catalogDir, nonInteractive: true })
    await stackAdd("web", "home", { cwd: dir, catalogDir, nonInteractive: true })

    await stackRemove("traefik", "home", { cwd: dir, catalogDir, force: true, dropEnv: true })

    const cfg = await readServerConfig(join(dir, "servers", "home"))
    assertEquals(cfg.stacks.map((s) => s.name), ["web"])
  })
})
