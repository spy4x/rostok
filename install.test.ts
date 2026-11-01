// Runs install.sh against a fake release laid out on disk and read through a file:// URL.

import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl, join, toFileUrl } from "@std/path"
import { assetName, sha256Hex } from "./cli/upgrade.ts"

const FAKE_BINARY = `#!/bin/sh\necho "rostok 1.99.0"\n`

/** The asset install.sh asks for on this machine. */
function hostAsset(): string {
  const os = Deno.build.os === "darwin" ? "apple-darwin" : "unknown-linux-gnu"
  return assetName(`${Deno.build.arch}-${os}`)
}

async function gz(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Lays `files` out as both the latest and the 1.99.0 release under a temp dir and passes its
 * `file://` URL, which curl reads like the GitHub URL, so the test needs no network.
 */
async function withRelease(
  files: Record<string, Uint8Array | string>,
  fn: (url: string, installDir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-install-test-" })
  try {
    for (const sub of ["latest/download", "download/v1.99.0"]) {
      await Deno.mkdir(join(dir, "releases", sub), { recursive: true })
      for (const [name, body] of Object.entries(files)) {
        const path = join(dir, "releases", sub, name)
        if (typeof body === "string") await Deno.writeTextFile(path, body)
        else await Deno.writeFile(path, body)
      }
    }
    await fn(toFileUrl(join(dir, "releases")).href, join(dir, "bin"))
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

async function runInstall(url: string, installDir: string, args: string[] = []) {
  const out = await new Deno.Command("sh", {
    args: [fromFileUrl(new URL("./install.sh", import.meta.url)), ...args],
    env: { ROSTOK_TEST_RELEASES_URL: url, ROSTOK_INSTALL: installDir },
    stdout: "piped",
    stderr: "piped",
  }).output()
  const text = new TextDecoder()
  return { code: out.code, stdout: text.decode(out.stdout), stderr: text.decode(out.stderr) }
}

Deno.test("install.sh installs the verified binary for this machine", async () => {
  const body = await gz(FAKE_BINARY)
  const name = hostAsset()
  await withRelease(
    { [name]: body, SHA256SUMS: `${await sha256Hex(body)}  ${name}\n` },
    async (url, dir) => {
      const res = await runInstall(url, dir)
      assertEquals(res.code, 0, res.stderr)
      assertStringIncludes(res.stdout, `Installed rostok 1.99.0 to ${dir}/rostok`)
      assertEquals(await Deno.readTextFile(join(dir, "rostok")), FAKE_BINARY)
    },
  )
})

Deno.test("install.sh downloads a given version from its own release", async () => {
  const body = await gz(FAKE_BINARY)
  const name = hostAsset()
  await withRelease(
    { [name]: body, SHA256SUMS: `${await sha256Hex(body)}  ${name}\n` },
    async (url, dir) => {
      await Deno.remove(fromFileUrl(`${url}/latest`), { recursive: true })
      const res = await runInstall(url, dir, ["v1.99.0"])
      assertEquals(res.code, 0, res.stderr)
      assertEquals(await Deno.readTextFile(join(dir, "rostok")), FAKE_BINARY)
    },
  )
})

Deno.test("install.sh refuses a binary whose checksum does not match", async () => {
  const body = await gz(FAKE_BINARY)
  const name = hostAsset()
  await withRelease(
    { [name]: body, SHA256SUMS: `${await sha256Hex(new Uint8Array([1]))}  ${name}\n` },
    async (url, dir) => {
      const res = await runInstall(url, dir)
      assertEquals(res.code, 1)
      assertStringIncludes(res.stderr, "checksum mismatch")
      let installed = true
      await Deno.stat(join(dir, "rostok")).catch(() => installed = false)
      assertEquals(installed, false)
    },
  )
})
