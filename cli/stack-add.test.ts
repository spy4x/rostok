// Tests for cli/stack-add.ts — #208 (path traversal), #210 (shared
// .env ownership: keep existing values, never rotate secrets, missing
// server fails clean, unresolved ${...} fails clean).

import { assertEquals, assertRejects } from "@std/assert"
import { join } from "@std/path"
import { UserError } from "./errors.ts"
import { readEnvFile } from "./env-files.ts"
import { stackAdd } from "./stack-add.ts"

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-stack-add-" })
  try {
    return await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {})
  }
}

/** Write a fixture catalog with one stack directory per entry in `stacks`. */
async function writeCatalog(
  catalogDir: string,
  stacks: Record<string, string>,
): Promise<void> {
  for (const [name, meta] of Object.entries(stacks)) {
    await Deno.mkdir(join(catalogDir, name), { recursive: true })
    await Deno.writeTextFile(join(catalogDir, name, "+meta.ts"), meta)
  }
}

const IMAGE_STACK_META = (name: string, imageTag: string) => `
import type { StackMeta } from "@rostok/cli"
export default {
  name: "${name}",
  description: "fixture",
  variables: [
    { key: "IMAGE_TAG", default: "${imageTag}", required: false },
    { key: "${name.toUpperCase()}_DOMAIN", default: "${name}.\${DOMAIN}", required: true },
  ],
} satisfies StackMeta
`

const SECRET_STACK_META = `
import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"
export default {
  name: "secretstack",
  description: "fixture",
  variables: [
    {
      key: "SECRETSTACK_PASSWORD",
      default: () => generatePassword(16),
      required: true,
      secret: true,
    },
  ],
} satisfies StackMeta
`

const UNRESOLVED_STACK_META = `
import type { StackMeta } from "@rostok/cli"
export default {
  name: "badstack",
  description: "fixture",
  variables: [
    { key: "BADSTACK_PATH_MEDIA", default: "\${PATH_MEDIA}/badstack", required: true },
  ],
} satisfies StackMeta
`

async function seedServer(dir: string, name: string, env: Record<string, string>): Promise<void> {
  await Deno.mkdir(join(dir, "servers", name), { recursive: true })
  const text = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n"
  await Deno.writeTextFile(join(dir, "servers", name, ".env"), text)
}

// ─────────────────────────────────────────────────────────────────────
// #208 — path traversal in -s <server> exits non-zero and writes nothing.
// ─────────────────────────────────────────────────────────────────────

Deno.test("stack add rejects a traversal server name and writes nothing outside servers/", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, { demo: IMAGE_STACK_META("demo", "1.0") })
    await assertRejects(
      () => stackAdd("demo", "../escaped", { cwd: dir, catalogDir }),
      UserError,
      "invalid server name",
    )
    const entries: string[] = []
    for await (const e of Deno.readDir(dir)) entries.push(e.name)
    assertEquals(entries, ["catalog"], "only the test's own catalog fixture should exist")
  })
})

// ─────────────────────────────────────────────────────────────────────
// #210 point 3 — a missing server fails clean and writes nothing.
// ─────────────────────────────────────────────────────────────────────

Deno.test("stack add on a missing server fails and writes nothing", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, { demo: IMAGE_STACK_META("demo", "1.0") })
    await assertRejects(
      () => stackAdd("demo", "ghost", { cwd: dir, catalogDir }),
      UserError,
      'server "ghost" not found: run rostok server create ghost',
    )
    const serversDir = join(dir, "servers")
    const exists = await Deno.stat(serversDir).then(() => true).catch(() => false)
    assertEquals(exists, false, "stack add must not create servers/ for a missing server")
  })
})

// ─────────────────────────────────────────────────────────────────────
// #210 point 1 — adding two stacks never changes a key the first wrote.
// ─────────────────────────────────────────────────────────────────────

Deno.test("adding a second stack never changes the first stack's IMAGE_TAG", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, {
      jellyfin: IMAGE_STACK_META("jellyfin", "latest"),
      traefik: IMAGE_STACK_META("traefik", "3.7.6"),
    })
    await seedServer(dir, "test", { PROJECT: "hl", DOMAIN: "example.com" })

    await stackAdd("jellyfin", "test", { cwd: dir, catalogDir, nonInteractive: true })
    await stackAdd("traefik", "test", { cwd: dir, catalogDir, nonInteractive: true })

    const env = await readEnvFile(join(dir, "servers", "test", ".env"))
    assertEquals(env.find((e) => e.key === "IMAGE_TAG")?.value, "latest")
  })
})

// ─────────────────────────────────────────────────────────────────────
// #210 point 2 — re-running stack add never rotates a generated secret.
// ─────────────────────────────────────────────────────────────────────

Deno.test("re-running stack add keeps an existing generated secret", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, { secretstack: SECRET_STACK_META })
    await seedServer(dir, "test", { PROJECT: "hl", DOMAIN: "example.com" })

    await stackAdd("secretstack", "test", { cwd: dir, catalogDir, nonInteractive: true })
    const first = (await readEnvFile(join(dir, "servers", "test", ".env")))
      .find((e) => e.key === "SECRETSTACK_PASSWORD")?.value

    const second = await stackAdd("secretstack", "test", {
      cwd: dir,
      catalogDir,
      nonInteractive: true,
    })
    const after = (await readEnvFile(join(dir, "servers", "test", ".env")))
      .find((e) => e.key === "SECRETSTACK_PASSWORD")?.value

    assertEquals(after, first, "the secret must not change on re-run")
    assertEquals(second.newCount, 0)
    assertEquals(second.keptCount, 1)
  })
})

Deno.test("an explicit --var still overrides an existing value", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, { secretstack: SECRET_STACK_META })
    await seedServer(dir, "test", { PROJECT: "hl", DOMAIN: "example.com" })

    await stackAdd("secretstack", "test", { cwd: dir, catalogDir, nonInteractive: true })
    await stackAdd("secretstack", "test", {
      cwd: dir,
      catalogDir,
      nonInteractive: true,
      providedVars: { SECRETSTACK_PASSWORD: "chosen-by-user" },
    })

    const env = await readEnvFile(join(dir, "servers", "test", ".env"))
    assertEquals(env.find((e) => e.key === "SECRETSTACK_PASSWORD")?.value, "chosen-by-user")
  })
})

// ─────────────────────────────────────────────────────────────────────
// #210 point 4 — an unresolved ${...} reference after default
// resolution is an error naming the key, and writes nothing.
// ─────────────────────────────────────────────────────────────────────

Deno.test("an unresolved reference after default resolution fails naming the key", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, { badstack: UNRESOLVED_STACK_META })
    // PATH_MEDIA is never set on this server — the default can't resolve.
    await seedServer(dir, "test", { PROJECT: "hl", DOMAIN: "example.com" })

    await assertRejects(
      () => stackAdd("badstack", "test", { cwd: dir, catalogDir, nonInteractive: true }),
      UserError,
      "unresolved reference in BADSTACK_PATH_MEDIA",
    )
    const env = await readEnvFile(join(dir, "servers", "test", ".env"))
    assertEquals(env.some((e) => e.key === "BADSTACK_PATH_MEDIA"), false)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Summary line + a server key already in .env is kept, not re-prompted.
// ─────────────────────────────────────────────────────────────────────

Deno.test("stack add keeps a server-level key already in .env (e.g. CONTACT_EMAIL)", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    const meta = `
import type { StackMeta } from "@rostok/cli"
export default {
  name: "proxy",
  description: "fixture",
  variables: [
    { key: "CONTACT_EMAIL", question: "Email?", required: true },
  ],
} satisfies StackMeta
`
    await writeCatalog(catalogDir, { proxy: meta })
    await seedServer(dir, "test", {
      PROJECT: "hl",
      DOMAIN: "example.com",
      CONTACT_EMAIL: "ops@example.com",
    })

    const result = await stackAdd("proxy", "test", { cwd: dir, catalogDir, nonInteractive: true })
    assertEquals(result.keptCount, 1)
    assertEquals(result.newCount, 0)
    const env = await readEnvFile(join(dir, "servers", "test", ".env"))
    assertEquals(env.find((e) => e.key === "CONTACT_EMAIL")?.value, "ops@example.com")
  })
})
