import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { runImagesOutdated, runImagesUpdate } from "../commands/images.ts"
import { UserError } from "../errors.ts"
import { fakeRegistry, sha } from "./fake-registry.test.ts"
import { checkPins } from "./outdated.ts"
import { createRegistryClient } from "./registry.ts"

const SERVER_ENV = `# home server
DOMAIN=example.com
GATUS_IMAGE_TAG=v5.11.0
GATUS_DB_IMAGE_TAG=16.8
WEB_IMAGE_TAG=latest@${sha("d0")}
WEB_CACHE_IMAGE_TAG=alpine
PROXY_IMAGE_TAG=3.7.6
`

/**
 * A small project: server `home` runs three stacks whose compose files
 * live in the project's own `stacks/`. Between them they cover a version
 * pin, a pin under a version default (postgres), a digest pin, a
 * floating tag, an unset variable and a pin that is already the newest.
 */
async function withProject<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-images-" })
  try {
    const stacks: Record<string, string> = {
      gatus: `services:
  gatus:
    image: ghcr.io/twin/gatus:\${GATUS_IMAGE_TAG:-latest}
  db:
    image: postgres:\${GATUS_DB_IMAGE_TAG:-16}
`,
      web: `services:
  web:
    image: quay.io/acme/web:\${WEB_IMAGE_TAG:-latest}
  cache:
    image: nginx:\${WEB_CACHE_IMAGE_TAG:-alpine}
  unset:
    image: acme/unset:\${WEB_UNSET_IMAGE_TAG:-latest}
`,
      proxy: `services:
  proxy:
    image: traefik:\${PROXY_IMAGE_TAG:-3.7.6}
`,
    }
    for (const [name, compose] of Object.entries(stacks)) {
      await Deno.mkdir(join(dir, "stacks", name), { recursive: true })
      await Deno.writeTextFile(join(dir, "stacks", name, "compose.yml"), compose)
    }
    await Deno.mkdir(join(dir, "servers", "home"), { recursive: true })
    await Deno.writeTextFile(join(dir, "servers", "home", ".env"), SERVER_ENV)
    await Deno.writeTextFile(
      join(dir, "servers", "home", "config.json"),
      JSON.stringify({ stacks: Object.keys(stacks).map((name) => ({ name })) }),
    )
    return await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

function registryFixture() {
  return fakeRegistry({
    "ghcr.io/twin/gatus": {
      tags: {
        latest: sha("b2"),
        "v5.11.0": sha("b0"),
        "v5.12.1": sha("b1"),
        "v6.0.0": sha("b2"),
        "v6.1.0-rc1": sha("b3"),
        "6.5.0": sha("b4"),
      },
      source: "https://github.com/TwiN/gatus",
    },
    "registry-1.docker.io/library/postgres": {
      tags: { "16": sha("e1"), "16.8": sha("e0"), "16.9": sha("e1"), "17.5": sha("e2") },
    },
    "quay.io/acme/web": { tags: { latest: sha("d1") } },
    "registry-1.docker.io/library/traefik": { tags: { "3.7.6": sha("f1"), "3.7.5": sha("f0") } },
  })
}

async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = []
  const original = { log: console.log, warn: console.warn, info: console.info }
  console.log = console.warn = console.info = (...args: unknown[]) => lines.push(args.join(" "))
  try {
    return { result: await fn(), lines }
  } finally {
    Object.assign(console, original)
  }
}

const serverEnvPath = (dir: string) => join(dir, "servers", "home", ".env")

Deno.test("images outdated lists each tag variable with its newest version: version pin, digest pin, newest, floating and unset", async () => {
  await withProject(async (dir) => {
    const { result: rows, lines } = await capture(() =>
      runImagesOutdated("home", dir, { fetch: registryFixture().fetch })
    )
    const byVariable = Object.fromEntries(rows.map((r) => [r.variable, r]))
    assertEquals(byVariable.GATUS_IMAGE_TAG.state, "outdated")
    assertEquals(byVariable.GATUS_IMAGE_TAG.newest, "v6.0.0")
    assertEquals(byVariable.WEB_IMAGE_TAG.newest, `latest@${sha("d1")}`)
    assertEquals(byVariable.PROXY_IMAGE_TAG.state, "current")
    assertEquals(byVariable.WEB_CACHE_IMAGE_TAG.state, "floating")
    assertEquals(byVariable.WEB_UNSET_IMAGE_TAG.state, "floating")

    const text = lines.join("\n")
    assertStringIncludes(text, "GATUS_IMAGE_TAG      ghcr.io/twin/gatus  v5.11.0 → v6.0.0")
    assertStringIncludes(text, "PROXY_IMAGE_TAG      traefik             3.7.6 (newest)")
    assertStringIncludes(text, "alpine (not pinned)")
    assertStringIncludes(text, `(not set, follows "latest")`)
    assertStringIncludes(text, "3 outdated: run `rostok images update home` to move them.")
    // Reading only: the .env is untouched.
    assertEquals(await Deno.readTextFile(serverEnvPath(dir)), SERVER_ENV)
  })
})

Deno.test("images outdated keeps a pin inside its major version when the compose default is a version", async () => {
  await withProject(async (dir) => {
    const client = createRegistryClient({ fetch: registryFixture().fetch })
    const rows = await checkPins(dir, "home", client, "gatus")
    // postgres: compose default 16, so 16.8 moves to 16.9 and never to 17.5.
    assertEquals(rows.find((r) => r.variable === "GATUS_DB_IMAGE_TAG")?.newest, "16.9")
  })
})

Deno.test("images outdated without a server checks every server of the project", async () => {
  await withProject(async (dir) => {
    await Deno.mkdir(join(dir, "servers", "cloud"), { recursive: true })
    await Deno.writeTextFile(join(dir, "servers", "cloud", ".env"), "PROXY_IMAGE_TAG=3.7.5\n")
    await Deno.writeTextFile(
      join(dir, "servers", "cloud", "config.json"),
      JSON.stringify({ stacks: [{ name: "proxy" }] }),
    )
    const { result: rows } = await capture(() =>
      runImagesOutdated(undefined, dir, { fetch: registryFixture().fetch })
    )
    assertEquals(
      rows.filter((r) => r.variable === "PROXY_IMAGE_TAG").map((r) => [r.server, r.newest]),
      [["cloud", "3.7.6"], ["home", undefined]],
    )
  })
})

Deno.test("images outdated reports a registry it cannot reach on that row and still lists the others", async () => {
  await withProject(async (dir) => {
    const registry = registryFixture()
    registry.down.add("ghcr.io")
    const { result: rows, lines } = await capture(() =>
      runImagesOutdated("home", dir, { fetch: registry.fetch })
    )
    assertEquals(rows.find((r) => r.variable === "GATUS_IMAGE_TAG")?.state, "unknown")
    assertEquals(rows.find((r) => r.variable === "GATUS_DB_IMAGE_TAG")?.newest, "16.9")
    assertStringIncludes(
      lines.join("\n"),
      "v5.11.0 (could not check: registry unreachable (ghcr.io))",
    )
  })
})

Deno.test("images update rewrites the outdated pins in the server's .env, keeps every other line, and tells the user to deploy", async () => {
  await withProject(async (dir) => {
    const { lines } = await capture(() =>
      runImagesUpdate("home", undefined, dir, { fetch: registryFixture().fetch })
    )
    assertEquals(
      await Deno.readTextFile(serverEnvPath(dir)),
      `# home server
DOMAIN=example.com
GATUS_IMAGE_TAG=v6.0.0
GATUS_DB_IMAGE_TAG=16.9
WEB_IMAGE_TAG=latest@${sha("d1")}
WEB_CACHE_IMAGE_TAG=alpine
PROXY_IMAGE_TAG=3.7.6
`,
    )
    const text = lines.join("\n")
    assertStringIncludes(text, "GATUS_IMAGE_TAG: v5.11.0 → v6.0.0")
    assertStringIncludes(
      text,
      "Updated 3 pins in servers/home/.env. Run `rostok deploy home` to apply.",
    )
  })
})

Deno.test("images update prints the image's source link when it has one, and its registry page otherwise", async () => {
  await withProject(async (dir) => {
    const { lines } = await capture(() =>
      runImagesUpdate("home", undefined, dir, { fetch: registryFixture().fetch })
    )
    const linkAfter = (variable: string) =>
      lines[lines.findIndex((l) => l.startsWith(`${variable}:`)) + 1].trim()
    assertEquals(linkAfter("GATUS_IMAGE_TAG"), "https://github.com/TwiN/gatus")
    assertEquals(linkAfter("GATUS_DB_IMAGE_TAG"), "https://hub.docker.com/_/postgres")
    assertEquals(linkAfter("WEB_IMAGE_TAG"), "https://quay.io/repository/acme/web")
  })
})

Deno.test("images update with a stack name moves only that stack's pins", async () => {
  await withProject(async (dir) => {
    await capture(() => runImagesUpdate("home", "web", dir, { fetch: registryFixture().fetch }))
    const env = await Deno.readTextFile(serverEnvPath(dir))
    assertStringIncludes(env, `WEB_IMAGE_TAG=latest@${sha("d1")}`)
    assertStringIncludes(env, "GATUS_IMAGE_TAG=v5.11.0")
    assertStringIncludes(env, "GATUS_DB_IMAGE_TAG=16.8")
  })
})

Deno.test("images update with nothing newer says so and leaves the .env byte for byte", async () => {
  await withProject(async (dir) => {
    const { lines } = await capture(() =>
      runImagesUpdate("home", "proxy", dir, { fetch: registryFixture().fetch })
    )
    assertEquals(lines, ["Nothing to update on home."])
    assertEquals(await Deno.readTextFile(serverEnvPath(dir)), SERVER_ENV)
  })
})

Deno.test("images update warns about an image it could not check and still moves the others", async () => {
  await withProject(async (dir) => {
    const registry = registryFixture()
    registry.rateLimited.add("ghcr.io")
    const { lines } = await capture(() =>
      runImagesUpdate("home", "gatus", dir, { fetch: registry.fetch })
    )
    const env = await Deno.readTextFile(serverEnvPath(dir))
    assertStringIncludes(env, "GATUS_IMAGE_TAG=v5.11.0")
    assertStringIncludes(env, "GATUS_DB_IMAGE_TAG=16.9")
    assertStringIncludes(
      lines.join("\n"),
      "rostok: could not check ghcr.io/twin/gatus (rate-limited by ghcr.io (HTTP 429)).",
    )
  })
})

Deno.test("images commands refuse a server that does not exist and a stack that is not on the server", async () => {
  await withProject(async (dir) => {
    const fetchFn = registryFixture().fetch
    await assertRejects(
      () => runImagesOutdated("nope", dir, { fetch: fetchFn }),
      UserError,
      "server 'nope' not found",
    )
    await assertRejects(
      () => runImagesUpdate("home", "jellyfin", dir, { fetch: fetchFn }),
      UserError,
      "stack 'jellyfin' is not on server 'home'",
    )
  })
})
