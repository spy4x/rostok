// Tests for cli/stack-add.ts — #208 (path traversal), #210 (shared
// .env ownership: keep existing values, never rotate secrets, missing
// server fails clean, unresolved ${...} fails clean).

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { UserError } from "./errors.ts"
import { readEnvFile } from "./env-files.ts"
import { stackAdd } from "./stack-add.ts"
import type { PromptBase } from "./prompts.ts"
import { fakeRegistry, sha } from "./images/fake-registry.test.ts"

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

// ─────────────────────────────────────────────────────────────────────
// #212 point 1 — a stack that `requires` another one gets that
// dependency added first. Non-interactive mode adds it automatically;
// interactive mode's yes/no is driven below through `confirmFn` (no
// real TTY needed).
// ─────────────────────────────────────────────────────────────────────

const WEB_STACK_META = (name: string, requires: string[]) => `
import type { StackMeta } from "@rostok/cli"
export default {
  name: "${name}",
  description: "fixture",
  requires: ${JSON.stringify(requires)},
  variables: [
    { key: "${name.toUpperCase()}_DOMAIN", default: "${name}.\${DOMAIN}", required: true },
  ],
} satisfies StackMeta
`

async function readServerConfigStacks(dir: string, serverName: string): Promise<string[]> {
  const text = await Deno.readTextFile(join(dir, "servers", serverName, "config.json"))
  const cfg = JSON.parse(text) as { stacks: { name: string }[] }
  return cfg.stacks.map((s) => s.name)
}

Deno.test("stack add -n automatically adds a missing requires dependency first", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, {
      traefik: IMAGE_STACK_META("traefik", "3.0"),
      web: WEB_STACK_META("web", ["traefik"]),
    })
    await seedServer(dir, "test", { DOMAIN: "example.com" })
    await stackAdd("web", "test", { cwd: dir, catalogDir, nonInteractive: true })

    const stacks = await readServerConfigStacks(dir, "test")
    assertEquals(stacks.includes("traefik"), true, "traefik should have been added first")
    assertEquals(stacks.includes("web"), true)

    const env = await readEnvFile(join(dir, "servers", "test", ".env"))
    assertEquals(env.some((e) => e.key === "TRAEFIK_DOMAIN"), true)
    assertEquals(env.some((e) => e.key === "WEB_DOMAIN"), true)
  })
})

Deno.test("stack add -n skips adding a requires dependency already on the server", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, {
      traefik: IMAGE_STACK_META("traefik", "3.0"),
      web: WEB_STACK_META("web", ["traefik"]),
    })
    await seedServer(dir, "test", { DOMAIN: "example.com" })
    await stackAdd("traefik", "test", { cwd: dir, catalogDir, nonInteractive: true })
    await stackAdd("web", "test", { cwd: dir, catalogDir, nonInteractive: true })

    const stacks = await readServerConfigStacks(dir, "test")
    // Both present exactly once — config.json's own de-dup (updateServerConfig)
    // proves the second call didn't re-add traefik.
    assertEquals(stacks.filter((s) => s === "traefik").length, 1)
    assertEquals(stacks.filter((s) => s === "web").length, 1)
  })
})

Deno.test("stack add on a stack with no requires never touches config.json's other entries", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, { demo: IMAGE_STACK_META("demo", "1.0") })
    await seedServer(dir, "test", { DOMAIN: "example.com" })
    await stackAdd("demo", "test", { cwd: dir, catalogDir, nonInteractive: true })
    const stacks = await readServerConfigStacks(dir, "test")
    assertEquals(stacks, ["demo"])
  })
})

// Review fix — interactive requires prompt, driven through `confirmFn`
// instead of a real TTY. Saying "yes" adds the dependency; saying "no"
// records it in `declinedRequires` and proceeds without it.

Deno.test("stack add interactively adds a requires dependency when the user says yes", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, {
      traefik: IMAGE_STACK_META("traefik", "3.0"),
      web: WEB_STACK_META("web", ["traefik"]),
    })
    await seedServer(dir, "test", { DOMAIN: "example.com" })
    const seenMessages: string[] = []
    const result = await stackAdd("web", "test", {
      cwd: dir,
      catalogDir,
      confirmFn: (opts) => {
        seenMessages.push(opts.message)
        return Promise.resolve(true)
      },
    })
    assertEquals(result.declinedRequires, [])
    assertEquals(seenMessages.some((m) => m.includes("requires 'traefik'")), true)
    const stacks = await readServerConfigStacks(dir, "test")
    assertEquals(stacks.includes("traefik"), true)
  })
})

Deno.test("stack add interactively skips a requires dependency when the user says no, records it as declined", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, {
      traefik: IMAGE_STACK_META("traefik", "3.0"),
      web: WEB_STACK_META("web", ["traefik"]),
    })
    await seedServer(dir, "test", { DOMAIN: "example.com" })
    const result = await stackAdd("web", "test", {
      cwd: dir,
      catalogDir,
      confirmFn: () => Promise.resolve(false),
    })
    assertEquals(result.declinedRequires, ["traefik"])
    const stacks = await readServerConfigStacks(dir, "test")
    assertEquals(stacks.includes("traefik"), false)
    assertEquals(stacks.includes("web"), true)
  })
})

// Review fix — a requires cycle (a requires b, b requires a) must stop
// with a one-line UserError instead of recursing forever.
Deno.test("stack add on a requires cycle (a -> b -> a) throws a UserError naming the cycle, not a stack overflow", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, {
      a: WEB_STACK_META("a", ["b"]),
      b: WEB_STACK_META("b", ["a"]),
    })
    await seedServer(dir, "test", { DOMAIN: "example.com" })
    await assertRejects(
      () => stackAdd("a", "test", { cwd: dir, catalogDir, nonInteractive: true }),
      UserError,
      "requires cycle",
    )
  })
})

// #211 — findStack's "unknown stack" error is a UserError (no stack
// trace at the CLI boundary), not a plain Error.
// Review fix — #212's "human label with the key in parentheses" claim
// for stack variables was never driven through the interactive branch
// either; `promptFn` captures the exact label cliffy would show.
const QUESTION_STACK_META = `
import type { StackMeta } from "@rostok/cli"
export default {
  name: "quiz",
  description: "fixture",
  variables: [{ key: "QUIZ_TOKEN", question: "API token for the quiz service", required: true }],
} satisfies StackMeta
`

Deno.test("stack add: the interactive variable prompt's label carries (KEY)", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, { quiz: QUESTION_STACK_META })
    await seedServer(dir, "test", { DOMAIN: "example.com" })
    const seen: PromptBase[] = []
    await stackAdd("quiz", "test", {
      cwd: dir,
      catalogDir,
      promptFn: (base) => {
        seen.push(base)
        return Promise.resolve("secret-token")
      },
    })
    assertEquals(seen.length, 1, seen.map((b) => b.message).join("\n"))
    assertStringIncludes(seen[0].message, "API token for the quiz service")
    assertStringIncludes(seen[0].message, "(QUIZ_TOKEN)")
  })
})

Deno.test("stack add: a typed value with ${...} is written literally, not reported (#313)", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, { quiz: QUESTION_STACK_META })
    await seedServer(dir, "test", { DOMAIN: "example.com" })
    await stackAdd("quiz", "test", {
      cwd: dir,
      catalogDir,
      promptFn: () => Promise.resolve("ab${cd}ef"),
    })
    const text = await Deno.readTextFile(join(dir, "servers", "test", ".env"))
    assertEquals(text.split("\n").filter((l) => l.startsWith("QUIZ_TOKEN=")), [
      "QUIZ_TOKEN='ab${cd}ef'",
    ])
  })
})

Deno.test("stack add on an unknown stack name fails as a UserError naming the catalog", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, { demo: IMAGE_STACK_META("demo", "1.0") })
    await seedServer(dir, "test", { DOMAIN: "example.com" })
    await assertRejects(
      () => stackAdd("nope", "test", { cwd: dir, catalogDir }),
      UserError,
      "stack 'nope' not found in catalog",
    )
  })
})

Deno.test("stack add on a missing server fails and writes nothing", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, { demo: IMAGE_STACK_META("demo", "1.0") })
    const err = await assertRejects(
      () => stackAdd("demo", "ghost", { cwd: dir, catalogDir }),
      UserError,
    )
    // #236: exact text — matches deploy's and stack-remove's own
    // "server not found" wording, which used to differ from this one.
    const envPath = join(dir, "servers", "ghost", ".env")
    assertEquals(
      err.message,
      `server 'ghost' not found at ${envPath}. Run \`rostok server create ghost\` first.`,
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

// #236 — stack add used to round-trip .env through parseEnv/serializeEnv,
// which silently drop every comment and blank line. A hand-annotated
// .env must survive a stack add untouched except for the added keys.
Deno.test("stack add preserves hand-written comments and blank lines in .env", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, { jellyfin: IMAGE_STACK_META("jellyfin", "latest") })
    await Deno.mkdir(join(dir, "servers", "test"), { recursive: true })
    const before = "# server-level settings\nPROJECT=hl\nDOMAIN=example.com\n\n# stacks below\n"
    await Deno.writeTextFile(join(dir, "servers", "test", ".env"), before)

    await stackAdd("jellyfin", "test", { cwd: dir, catalogDir, nonInteractive: true })

    const after = await Deno.readTextFile(join(dir, "servers", "test", ".env"))
    assertStringIncludes(after, "# server-level settings")
    assertStringIncludes(after, "# stacks below")
    assertStringIncludes(after, "\n\n") // the blank line between the two comment blocks survived
    assertStringIncludes(after, "IMAGE_TAG=latest") // the new key was still written
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

Deno.test("a --var value with $ is written single-quoted, and a re-run keeps it (#313)", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, { secretstack: SECRET_STACK_META })
    await seedServer(dir, "test", { PROJECT: "hl", DOMAIN: "example.com" })
    const providedVars = { SECRETSTACK_PASSWORD: "p$ssw0rd" }

    await stackAdd("secretstack", "test", {
      cwd: dir,
      catalogDir,
      nonInteractive: true,
      providedVars,
    })
    const second = await stackAdd("secretstack", "test", {
      cwd: dir,
      catalogDir,
      nonInteractive: true,
      providedVars,
    })

    const text = await Deno.readTextFile(join(dir, "servers", "test", ".env"))
    assertEquals(text.split("\n").filter((l) => l.startsWith("SECRETSTACK_PASSWORD=")), [
      "SECRETSTACK_PASSWORD='p$ssw0rd'",
    ])
    assertEquals(second.keptCount, 1)
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

// ─────────────────────────────────────────────────────────────────────
// Review fix #3 — ${SERVER_NAME} is the one reference the design doc
// guarantees resolves; it must not always fail the unresolved-reference
// check. Also: that check must only apply to a value resolved *this
// run* from a default, not to whatever was already sitting in .env.
// ─────────────────────────────────────────────────────────────────────

const SERVER_NAME_STACK_META = `
import type { StackMeta } from "@rostok/cli"
export default {
  name: "namedstack",
  description: "fixture",
  variables: [
    { key: "NAMEDSTACK_LABEL", default: "\${SERVER_NAME}-namedstack", required: true },
  ],
} satisfies StackMeta
`

Deno.test("a \${SERVER_NAME} default resolves to the server being added to", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, { namedstack: SERVER_NAME_STACK_META })
    await seedServer(dir, "test", { PROJECT: "hl", DOMAIN: "example.com" })

    const result = await stackAdd("namedstack", "test", {
      cwd: dir,
      catalogDir,
      nonInteractive: true,
    })
    assertEquals(
      result.writtenEntries.find((e) => e.key === "NAMEDSTACK_LABEL")?.value,
      "test-namedstack",
    )
  })
})

Deno.test("an unresolved \${...} already sitting in .env is left alone, not rejected", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, { badstack: UNRESOLVED_STACK_META })
    // Simulate stale hand-edited data: the key badstack declares already
    // has a literal, never-resolved reference sitting in .env from
    // before. stack add must not touch or reject it — only a value it
    // resolves itself this run is checked.
    await seedServer(dir, "test", {
      PROJECT: "hl",
      DOMAIN: "example.com",
      BADSTACK_PATH_MEDIA: "\${PATH_MEDIA}/badstack",
    })

    const result = await stackAdd("badstack", "test", {
      cwd: dir,
      catalogDir,
      nonInteractive: true,
    })
    assertEquals(result.keptCount, 1)
    assertEquals(
      result.writtenEntries.find((e) => e.key === "BADSTACK_PATH_MEDIA")?.value,
      "\${PATH_MEDIA}/badstack",
    )
  })
})

// ─────────────────────────────────────────────────────────────────────
// Review fix #9 — a --var equal to the existing value is "kept", not "new".
// ─────────────────────────────────────────────────────────────────────

Deno.test("a --var matching the existing value counts as kept, not new", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, { secretstack: SECRET_STACK_META })
    await seedServer(dir, "test", {
      PROJECT: "hl",
      DOMAIN: "example.com",
      SECRETSTACK_PASSWORD: "unchanged",
    })

    const result = await stackAdd("secretstack", "test", {
      cwd: dir,
      catalogDir,
      nonInteractive: true,
      providedVars: { SECRETSTACK_PASSWORD: "unchanged" },
    })
    assertEquals(result.newCount, 0)
    assertEquals(result.keptCount, 1)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Leftover from #227 review — `stack add` must refuse a stack whose own
// key prefix is reserved (same check validate-stack-config.ts makes at
// deploy time), so it fails at add time instead of only surfacing once
// it's already in config.json.
// ─────────────────────────────────────────────────────────────────────

const GIT_PREFIXED_STACK_META = `
import type { StackMeta } from "@rostok/cli"
export default {
  name: "git-mirror",
  description: "fixture — name collides with the reserved GIT_ prefix",
  variables: [{ key: "GIT_MIRROR_URL", default: "https://example.com", required: false }],
} satisfies StackMeta
`

Deno.test("stack add refuses a stack whose own key prefix is reserved (GIT_)", async () => {
  await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, { "git-mirror": GIT_PREFIXED_STACK_META })
    await seedServer(dir, "test", { PROJECT: "hl", DOMAIN: "example.com" })

    const err = await assertRejects(
      () => stackAdd("git-mirror", "test", { cwd: dir, catalogDir, nonInteractive: true }),
      UserError,
    )
    assertStringIncludes(
      err.message,
      `stack "git-mirror": its own key prefix "GIT_MIRROR_" is reserved — rename the stack.`,
    )

    // Mutation proof: nothing written when the refusal fires before any
    // .env mutation.
    const entries = await readEnvFile(join(dir, "servers", "test", ".env"))
    assertEquals(entries.some((e) => e.key === "GIT_MIRROR_URL"), false)
  })
})

// #340 — IMAGE_POLICY: under `pinned`, stack add writes the exact version
// of each variable-tagged image; under `latest` it leaves the tags as
// they were. Registry answers come from a fake `fetch`.

const GATUS_META = `
import type { StackMeta } from "@rostok/cli"
export default {
  name: "gatus",
  description: "fixture",
  variables: [
    { key: "GATUS_IMAGE_TAG", default: "latest", required: false },
    { key: "GATUS_DOMAIN", default: "uptime.\${DOMAIN}", required: true },
  ],
} satisfies StackMeta
`

/** gatus on GHCR (declared in +meta.ts) plus a database image whose tag variable +meta.ts doesn't declare. */
const GATUS_COMPOSE = `services:
  gatus:
    image: ghcr.io/twin/gatus:\${GATUS_IMAGE_TAG:-latest}
  db:
    image: postgres:\${GATUS_DB_IMAGE_TAG:-16}
`

function gatusRegistry() {
  return fakeRegistry({
    "ghcr.io/twin/gatus": {
      tags: { latest: sha("b1"), "v5.11.0": sha("b0"), "v5.12.1": sha("b1") },
    },
    "registry-1.docker.io/library/postgres": {
      tags: { "16": sha("e1"), "16.9": sha("e1"), "17.5": sha("e2"), latest: sha("e2") },
    },
  })
}

/** A project with server `home` and a fixture catalog holding the gatus stack. */
async function withGatusProject<T>(
  files: { rootEnv?: string; serverEnv?: string },
  fn: (dir: string, catalogDir: string) => Promise<T>,
): Promise<T> {
  return await withTmpDir(async (dir) => {
    const catalogDir = join(dir, "catalog")
    await writeCatalog(catalogDir, { gatus: GATUS_META })
    await Deno.writeTextFile(join(catalogDir, "gatus", "compose.yml"), GATUS_COMPOSE)
    await Deno.mkdir(join(dir, "servers", "home"), { recursive: true })
    await Deno.writeTextFile(
      join(dir, "servers", "home", ".env"),
      `DOMAIN=example.com\n${files.serverEnv ?? ""}`,
    )
    if (files.rootEnv !== undefined) await Deno.writeTextFile(join(dir, ".env.root"), files.rootEnv)
    return await fn(dir, catalogDir)
  })
}

async function serverEnvOf(dir: string): Promise<Record<string, string>> {
  const entries = await readEnvFile(join(dir, "servers", "home", ".env"))
  return Object.fromEntries(entries.map((e) => [e.key, e.value]))
}

Deno.test("pinned policy: stack add writes each image's exact version into the server's .env", async () => {
  await withGatusProject({}, async (dir, catalogDir) => {
    const registry = gatusRegistry()
    const result = await stackAdd("gatus", "home", {
      cwd: dir,
      catalogDir,
      nonInteractive: true,
      fetch: registry.fetch,
    })
    const env = await serverEnvOf(dir)
    assertEquals(env.GATUS_IMAGE_TAG, "v5.12.1")
    assertEquals(env.GATUS_DB_IMAGE_TAG, "16.9")
    assertEquals(env.GATUS_DOMAIN, "uptime.example.com")
    assertEquals(result.newCount, 3)
  })
})

Deno.test("pinned policy: an image with no version tag for its digest is pinned as latest@sha256", async () => {
  await withGatusProject({ rootEnv: "IMAGE_POLICY=pinned\n" }, async (dir, catalogDir) => {
    const registry = fakeRegistry({
      "ghcr.io/twin/gatus": { tags: { latest: sha("b1"), "v5.11.0": sha("b0") } },
      "registry-1.docker.io/library/postgres": { tags: { "16": sha("e1") } },
    })
    await stackAdd("gatus", "home", {
      cwd: dir,
      catalogDir,
      nonInteractive: true,
      fetch: registry.fetch,
    })
    const env = await serverEnvOf(dir)
    assertEquals(env.GATUS_IMAGE_TAG, `latest@${sha("b1")}`)
    assertEquals(env.GATUS_DB_IMAGE_TAG, `16@${sha("e1")}`)
  })
})

Deno.test("latest policy in .env.root: stack add asks no registry and writes no pin", async () => {
  await withGatusProject({ rootEnv: "IMAGE_POLICY=latest\n" }, async (dir, catalogDir) => {
    const registry = gatusRegistry()
    await stackAdd("gatus", "home", {
      cwd: dir,
      catalogDir,
      nonInteractive: true,
      fetch: registry.fetch,
    })
    const env = await serverEnvOf(dir)
    assertEquals(registry.calls, [])
    assertEquals(env.GATUS_IMAGE_TAG, "latest") // the stack's own default, as before #340
    assertEquals("GATUS_DB_IMAGE_TAG" in env, false)
  })
})

Deno.test("a server's IMAGE_POLICY wins over the project's at stack add, in both directions", async () => {
  await withGatusProject(
    { rootEnv: "IMAGE_POLICY=pinned\n", serverEnv: "IMAGE_POLICY=latest\n" },
    async (dir, catalogDir) => {
      const registry = gatusRegistry()
      await stackAdd("gatus", "home", {
        cwd: dir,
        catalogDir,
        nonInteractive: true,
        fetch: registry.fetch,
      })
      assertEquals(registry.calls, [])
      assertEquals((await serverEnvOf(dir)).GATUS_IMAGE_TAG, "latest")
    },
  )
  await withGatusProject(
    { rootEnv: "IMAGE_POLICY=latest\n", serverEnv: "IMAGE_POLICY=pinned\n" },
    async (dir, catalogDir) => {
      await stackAdd("gatus", "home", {
        cwd: dir,
        catalogDir,
        nonInteractive: true,
        fetch: gatusRegistry().fetch,
      })
      assertEquals((await serverEnvOf(dir)).GATUS_IMAGE_TAG, "v5.12.1")
    },
  )
})

Deno.test("pinned policy: a tag the user already has in .env, or passes with --var, is never overwritten", async () => {
  await withGatusProject(
    // The user's own choices, one of them on another major version than the compose default.
    { serverEnv: "GATUS_DB_IMAGE_TAG=17.5\n" },
    async (dir, catalogDir) => {
      const registry = gatusRegistry()
      await stackAdd("gatus", "home", {
        cwd: dir,
        catalogDir,
        nonInteractive: true,
        providedVars: { GATUS_IMAGE_TAG: "latest" },
        fetch: registry.fetch,
      })
      const env = await serverEnvOf(dir)
      assertEquals(env.GATUS_DB_IMAGE_TAG, "17.5")
      assertEquals(env.GATUS_IMAGE_TAG, "latest")
      assertEquals(registry.calls, [])
    },
  )
})

Deno.test("pinned policy: an unreachable registry warns once per image, leaves its variable unset and still adds the stack", async () => {
  await withGatusProject({}, async (dir, catalogDir) => {
    const registry = gatusRegistry()
    registry.down.add("ghcr.io")
    const warnings: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
    try {
      await stackAdd("gatus", "home", {
        cwd: dir,
        catalogDir,
        nonInteractive: true,
        fetch: registry.fetch,
      })
    } finally {
      console.warn = originalWarn
    }
    const env = await serverEnvOf(dir)
    assertEquals("GATUS_IMAGE_TAG" in env, false)
    assertEquals(env.GATUS_DB_IMAGE_TAG, "16.9")
    assertEquals(env.GATUS_DOMAIN, "uptime.example.com")
    const pinWarnings = warnings.filter((w) => w.includes("could not pin"))
    assertEquals(pinWarnings.length, 1)
    assertStringIncludes(pinWarnings[0], "ghcr.io/twin/gatus:latest")
    const config = JSON.parse(await Deno.readTextFile(join(dir, "servers", "home", "config.json")))
    assertEquals(config.stacks, [{ name: "gatus" }])

    // The registry is back: the same command pins what it could not pin before.
    registry.down.clear()
    await stackAdd("gatus", "home", {
      cwd: dir,
      catalogDir,
      nonInteractive: true,
      fetch: registry.fetch,
    })
    assertEquals((await serverEnvOf(dir)).GATUS_IMAGE_TAG, "v5.12.1")
  })
})

Deno.test("pinned policy: a database default of 16 is never pinned to another major version", async () => {
  await withGatusProject({}, async (dir, catalogDir) => {
    // `16` and a wrongly pushed 17.5 share one digest; no 16.x tag does.
    const registry = fakeRegistry({
      "ghcr.io/twin/gatus": { tags: { latest: sha("b1"), "v5.12.1": sha("b1") } },
      "registry-1.docker.io/library/postgres": {
        tags: { "16": sha("e1"), "17.5": sha("e1"), "16.8": sha("e0") },
      },
    })
    await stackAdd("gatus", "home", {
      cwd: dir,
      catalogDir,
      nonInteractive: true,
      fetch: registry.fetch,
    })
    assertEquals((await serverEnvOf(dir)).GATUS_DB_IMAGE_TAG, `16@${sha("e1")}`)
  })
})

Deno.test("an invalid IMAGE_POLICY stops stack add before it writes anything", async () => {
  await withGatusProject({ rootEnv: "IMAGE_POLICY=sometimes\n" }, async (dir, catalogDir) => {
    await assertRejects(
      () => stackAdd("gatus", "home", { cwd: dir, catalogDir, nonInteractive: true }),
      UserError,
      ".env.root: IMAGE_POLICY must be",
    )
    assertEquals(await serverEnvOf(dir), { DOMAIN: "example.com" })
  })
})

// A CLI installed from a package host downloads a shipped stack's compose
// file. These two tests add the catalog's own traefik stack, with that
// download failing in the two ways a host fails.
for (
  const [failure, reason, fetchFn] of [
    [
      "is unreachable",
      "packages.example.com unreachable",
      () => Promise.reject(new TypeError("connection refused")),
    ],
    [
      "answers 404",
      "packages.example.com answered HTTP 404",
      () => Promise.resolve(new Response("not found", { status: 404 })),
    ],
  ] as const
) {
  Deno.test(`pinned policy: when the package host ${failure} for the compose file, stack add warns once, adds the stack and writes no floating image tag`, async () => {
    await withTmpDir(async (dir) => {
      await Deno.mkdir(join(dir, "servers", "home"), { recursive: true })
      await Deno.writeTextFile(join(dir, "servers", "home", ".env"), "DOMAIN=example.com\n")
      const warnings: string[] = []
      const originalWarn = console.warn
      console.warn = (...args: unknown[]) => warnings.push(args.join(" "))
      try {
        await stackAdd("traefik", "home", {
          cwd: dir,
          nonInteractive: true,
          fetch: fetchFn as typeof fetch,
          resolveStackFiles: () =>
            Promise.resolve({
              files: new Map([[
                "compose.yml",
                "https://packages.example.com/stacks/traefik/compose.yml",
              ]]),
              origin: "shipped",
            }),
        })
      } finally {
        console.warn = originalWarn
      }
      assertEquals(warnings.filter((w) => w.includes("compose file")), [
        `rostok: could not read the compose file of stack 'traefik' (${reason}), so its image ` +
        "versions are not pinned. Run the same `rostok stack add` again to pin them.",
      ])
      const env = await serverEnvOf(dir)
      assertEquals(Object.keys(env).filter((key) => key.endsWith("_IMAGE_TAG")), [])
      assertEquals(env.DOMAIN, "example.com")
      const config = JSON.parse(
        await Deno.readTextFile(join(dir, "servers", "home", "config.json")),
      )
      assertEquals(config.stacks, [{ name: "traefik" }])
    })
  })
}
