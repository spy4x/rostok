// Tests for stacks/pangolin/before.deploy.ts: the server's Traefik files reach the directory the
// Pangolin Traefik reads, and a server without any still deploys.

import { assertEquals, assertRejects } from "@std/assert"
import { join } from "@std/path"

import { copyServerConfigs, isDynamicConfigName } from "./before.deploy.ts"

async function withDirs(
  fn: (source: string, dest: string) => Promise<void>,
  files: Record<string, string> = {},
): Promise<void> {
  const root = await Deno.makeTempDir()
  try {
    const source = join(root, "source")
    const dest = join(root, "dest")
    await Deno.mkdir(source)
    await Deno.mkdir(dest)
    for (const [name, text] of Object.entries(files)) {
      await Deno.writeTextFile(join(source, name), text)
    }
    await fn(source, dest)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

Deno.test("copies the server's yml and yaml files next to the catalog file", async () => {
  await withDirs(async (source, dest) => {
    await Deno.writeTextFile(join(dest, "00-pangolin.yml"), "base")
    const copied = await copyServerConfigs(source, dest)
    assertEquals(copied.sort(), ["10-a.yml", "20-b.yaml"])
    assertEquals(await Deno.readTextFile(join(dest, "10-a.yml")), "a")
    assertEquals(await Deno.readTextFile(join(dest, "00-pangolin.yml")), "base")
  }, { "10-a.yml": "a", "20-b.yaml": "b", "notes.md": "x" })
})

Deno.test("ignores files that are not Traefik dynamic configs", async () => {
  await withDirs(async (source, dest) => {
    assertEquals(await copyServerConfigs(source, dest), [])
    assertEquals([...Deno.readDirSync(dest)].length, 0)
  }, { "README.md": "x", "a.yml.bak": "x" })
})

Deno.test("a server without a pangolin folder deploys with the catalog file only", async () => {
  await withDirs(async (source, dest) => {
    assertEquals(await copyServerConfigs(join(source, "missing"), dest), [])
  })
})

Deno.test("an empty server folder deploys with the catalog file only", async () => {
  await withDirs(async (source, dest) => {
    assertEquals(await copyServerConfigs(source, dest), [])
  })
})

Deno.test("refuses a server file that would replace the catalog's base file", async () => {
  await withDirs(async (source, dest) => {
    await assertRejects(() => copyServerConfigs(source, dest), Error, "00-pangolin.yml")
  }, { "00-pangolin.yml": "mine" })
})

Deno.test("isDynamicConfigName: yml and yaml only", () => {
  assertEquals(isDynamicConfigName("a.yml"), true)
  assertEquals(isDynamicConfigName("a.yaml"), true)
  assertEquals(isDynamicConfigName("a.json"), false)
})

Deno.test("the Pangolin Traefik reads the dynamic directory the catalog file lives in", async () => {
  const config = await Deno.readTextFile(new URL("./traefik/traefik_config.yml", import.meta.url))
  assertEquals(/^\s+directory: "\/etc\/traefik\/dynamic"$/m.test(config), true)
  assertEquals(/^\s+filename:/m.test(config), false)
  const base = await Deno.stat(new URL("./traefik/dynamic/00-pangolin.yml", import.meta.url))
  assertEquals(base.isFile, true)
})
