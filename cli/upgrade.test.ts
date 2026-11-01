import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { UserError } from "./errors.ts"
import {
  assetName,
  compareVersions,
  denoInstallCommand,
  fetchLatestVersion,
  normalizeVersion,
  sha256Hex,
  upgrade,
  type UpgradeDeps,
  verifyChecksum,
} from "./upgrade.ts"

const BASE = "https://releases.example.com/rostok/releases"
const TARGET = "x86_64-unknown-linux-gnu"

async function gz(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** A fetch that serves `files` (URL → body) and answers `<base>/latest` with a redirect. */
function fakeFetch(
  latest: string,
  files: Record<string, Uint8Array | string>,
  seen: string[] = [],
): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = String(input)
    seen.push(url)
    if (url === `${BASE}/latest`) {
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: `${BASE}/tag/v${latest}` } }),
      )
    }
    const body = files[url]
    if (body === undefined) return Promise.resolve(new Response("not found", { status: 404 }))
    return Promise.resolve(new Response(body as BodyInit))
  }) as typeof fetch
}

/** A temp dir with a fake current binary; returns its path and the deps for {@link upgrade}. */
async function setup(
  overrides: Partial<UpgradeDeps>,
): Promise<{ dir: string; execPath: string; deps: UpgradeDeps; logs: string[] }> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-upgrade-test-" })
  const execPath = join(dir, "rostok")
  await Deno.writeTextFile(execPath, "old binary")
  const logs: string[] = []
  const deps: UpgradeDeps = {
    standalone: true,
    target: TARGET,
    execPath,
    currentVersion: "1.23.0",
    releasesUrl: BASE,
    fetch: fakeFetch("1.23.0", {}),
    log: (line) => logs.push(line),
    runVersion: async (path) => `rostok ${(await Deno.readTextFile(path)).split(" ")[1]}`,
    ...overrides,
  }
  return { dir, execPath, deps, logs }
}

/** Release files for `version` whose binary is the text `binary <version>`. */
async function release(version: string, sumsFor?: Uint8Array) {
  const body = await gz(`binary ${version}`)
  const name = assetName(TARGET)
  const sums = `${await sha256Hex(sumsFor ?? body)}  ${name}\n`
  return {
    [`${BASE}/download/v${version}/${name}`]: body,
    [`${BASE}/download/v${version}/SHA256SUMS`]: sums,
  }
}

async function dirEntries(dir: string): Promise<string[]> {
  const names: string[] = []
  for await (const e of Deno.readDir(dir)) names.push(e.name)
  return names.sort()
}

Deno.test("compareVersions compares numerically, not as text", () => {
  assert(compareVersions("1.10.0", "1.9.0") > 0)
  assert(compareVersions("1.9.9", "2.0.0") < 0)
  assertEquals(compareVersions("v1.2.3", "1.2.3"), 0)
})

Deno.test("normalizeVersion rejects anything that is not x.y.z", () => {
  assertEquals(normalizeVersion("v1.24.0"), "1.24.0")
  assertEquals(normalizeVersion("1.24.0-rc.1"), undefined)
  assertEquals(normalizeVersion("1.24.0/../../evil"), undefined)
})

Deno.test("fetchLatestVersion reads the version from the latest-release redirect", async () => {
  assertEquals(await fetchLatestVersion(BASE, { fetch: fakeFetch("1.30.2", {}) }), "1.30.2")
  const noRedirect = (() => Promise.resolve(new Response("ok"))) as typeof fetch
  assertEquals(await fetchLatestVersion(BASE, { fetch: noRedirect }), undefined)
})

Deno.test("verifyChecksum refuses a mismatched or unlisted file", async () => {
  const bytes = new TextEncoder().encode("payload")
  const good = `${await sha256Hex(bytes)}  a.gz\n`
  await verifyChecksum("a.gz", bytes, good)
  await assertRejects(
    () => verifyChecksum("a.gz", new TextEncoder().encode("tampered"), good),
    UserError,
    "checksum mismatch",
  )
  await assertRejects(() => verifyChecksum("b.gz", bytes, good), UserError, "does not list")
})

Deno.test("upgrade replaces the binary with the latest release", async () => {
  const files = await release("1.24.0")
  const { dir, execPath, deps, logs } = await setup({ fetch: fakeFetch("1.24.0", files) })
  try {
    await upgrade(undefined, deps)
    assertEquals(await Deno.readTextFile(execPath), "binary 1.24.0")
    assertEquals(await dirEntries(dir), ["rostok"])
    assertStringIncludes(logs.at(-1)!, "1.23.0 → 1.24.0")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("upgrade refuses a download whose checksum does not match", async () => {
  const files = await release("1.24.0", new TextEncoder().encode("something else"))
  const { dir, execPath, deps } = await setup({ fetch: fakeFetch("1.24.0", files) })
  try {
    await assertRejects(() => upgrade(undefined, deps), UserError, "checksum mismatch")
    assertEquals(await Deno.readTextFile(execPath), "old binary")
    assertEquals(await dirEntries(dir), ["rostok"])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("upgrade keeps the old binary when the new one reports another version", async () => {
  const files = await release("1.24.0")
  const { dir, execPath, deps } = await setup({
    fetch: fakeFetch("1.24.0", files),
    runVersion: () => Promise.resolve("rostok 1.23.0"),
  })
  try {
    await assertRejects(() => upgrade(undefined, deps), UserError, "Nothing was replaced")
    assertEquals(await Deno.readTextFile(execPath), "old binary")
    assertEquals(await dirEntries(dir), ["rostok"])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("upgrade says so and downloads nothing when already current", async () => {
  const seen: string[] = []
  const { dir, execPath, deps, logs } = await setup({ fetch: fakeFetch("1.23.0", {}, seen) })
  try {
    await upgrade(undefined, deps)
    assertEquals(seen, [`${BASE}/latest`])
    assertEquals(await Deno.readTextFile(execPath), "old binary")
    assertStringIncludes(logs.join("\n"), "already installed")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("upgrade installs a given older version", async () => {
  const files = await release("1.20.0")
  const { dir, execPath, deps } = await setup({ fetch: fakeFetch("1.24.0", files) })
  try {
    await upgrade("v1.20.0", deps)
    assertEquals(await Deno.readTextFile(execPath), "binary 1.20.0")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("upgrade rejects a version argument that is not x.y.z", async () => {
  const seen: string[] = []
  const { dir, deps } = await setup({ fetch: fakeFetch("1.24.0", {}, seen) })
  try {
    await assertRejects(() => upgrade("1.0.0/../../x", deps), UserError, "not a version")
    assertEquals(seen, [])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("upgrade from a Deno install prints the deno install command instead", async () => {
  const seen: string[] = []
  const { dir, execPath, deps, logs } = await setup({
    standalone: false,
    fetch: fakeFetch("1.24.0", {}, seen),
  })
  try {
    await upgrade("1.24.0", deps)
    assertEquals(seen, [])
    assertEquals(await Deno.readTextFile(execPath), "old binary")
    assertStringIncludes(logs.join("\n"), denoInstallCommand("1.24.0"))
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
