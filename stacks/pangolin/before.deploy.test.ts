// Tests for stacks/pangolin/before.deploy.ts: the catalog files get the server's host and contact
// address, the server's Traefik files reach the directory the Pangolin Traefik reads, and a server
// without any still deploys.

import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert"
import { join } from "@std/path"

import {
  copyServerConfigs,
  fillCatalogFiles,
  FILLED_FILES,
  fillPlaceholders,
  isDynamicConfigName,
  resolveTraefikValues,
} from "./before.deploy.ts"

const VALUES = { PANGOLIN_DOMAIN: "tunnel.example.com", CONTACT_EMAIL: "admin@example.com" }

function envOf(vars: Record<string, string>): (key: string) => string | undefined {
  return (key) => vars[key]
}

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

Deno.test("never copies a symlink, so a link cannot pull in a file from outside", async () => {
  await withDirs(async (source, dest) => {
    const outside = join(source, "..", "outside.yml")
    await Deno.writeTextFile(outside, "secret")
    await Deno.symlink(outside, join(source, "10-link.yml"))
    assertEquals(await copyServerConfigs(source, dest), [])
    assertEquals([...Deno.readDirSync(dest)].length, 0)
  })
})

Deno.test("a missing destination fails instead of dropping the server's files", async () => {
  await withDirs(async (source, dest) => {
    await assertRejects(
      () => copyServerConfigs(source, join(dest, "missing")),
      Deno.errors.NotFound,
    )
  }, { "10-a.yml": "a" })
})

Deno.test("reads the dashboard host and the contact address from the env", () => {
  assertEquals(resolveTraefikValues(envOf({ ...VALUES })), VALUES)
})

Deno.test("refuses a deploy without PANGOLIN_DOMAIN", () => {
  assertThrows(
    () => resolveTraefikValues(envOf({ CONTACT_EMAIL: VALUES.CONTACT_EMAIL })),
    Error,
    "PANGOLIN_DOMAIN is not set",
  )
})

Deno.test("refuses a deploy without CONTACT_EMAIL", () => {
  assertThrows(
    () => resolveTraefikValues(envOf({ PANGOLIN_DOMAIN: VALUES.PANGOLIN_DOMAIN })),
    Error,
    "CONTACT_EMAIL is not set",
  )
})

Deno.test("refuses a host that would break out of the Traefik rule", () => {
  for (
    const bad of ["a.example.com`) || Host(`b.example.com", "https://a.example.com", "a b.com"]
  ) {
    assertThrows(
      () => resolveTraefikValues(envOf({ ...VALUES, PANGOLIN_DOMAIN: bad })),
      Error,
      "PANGOLIN_DOMAIN is not a plain host name",
    )
  }
})

Deno.test("refuses a contact address that would break out of the YAML string", () => {
  assertThrows(
    () => resolveTraefikValues(envOf({ ...VALUES, CONTACT_EMAIL: 'a"@example.com' })),
    Error,
    "CONTACT_EMAIL is not a plain e-mail address",
  )
})

Deno.test("fills every placeholder occurrence", () => {
  assertEquals(
    fillPlaceholders("Host(`${PANGOLIN_DOMAIN}`) ${PANGOLIN_DOMAIN} ${CONTACT_EMAIL}", VALUES),
    "Host(`tunnel.example.com`) tunnel.example.com admin@example.com",
  )
})

Deno.test("refuses a placeholder it does not know instead of shipping it as text", () => {
  assertThrows(() => fillPlaceholders("${PANGOLIN_OTHER}", VALUES), Error, "${PANGOLIN_OTHER}")
})

Deno.test("the catalog files name no host or address, only the placeholders", async () => {
  for (const rel of FILLED_FILES) {
    const text = await Deno.readTextFile(new URL(`./traefik/${rel}`, import.meta.url))
    for (const rule of text.matchAll(/Host\(([^)]*)\)/g)) {
      assertEquals(rule[1], "`${PANGOLIN_DOMAIN}`", `${rel}: ${rule[0]}`)
    }
    for (const email of text.matchAll(/^\s*email:\s*(.*)$/gm)) {
      assertEquals(email[1], '"${CONTACT_EMAIL}"', `${rel}: ${email[0]}`)
    }
  }
})

Deno.test("fills the staged catalog files so no placeholder reaches the server", async () => {
  const root = await Deno.makeTempDir()
  try {
    await Deno.mkdir(join(root, "dynamic"))
    for (const rel of FILLED_FILES) {
      await Deno.copyFile(new URL(`./traefik/${rel}`, import.meta.url), join(root, rel))
    }
    await fillCatalogFiles(root, VALUES)
    const base = await Deno.readTextFile(join(root, "dynamic/00-pangolin.yml"))
    const config = await Deno.readTextFile(join(root, "traefik_config.yml"))
    assertStringIncludes(base, 'rule: "Host(`tunnel.example.com`) && PathPrefix(`/api/v1`)"')
    assertStringIncludes(config, 'email: "admin@example.com"')
    assertEquals(/\$\{/.test(base + config), false)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("a missing catalog file fails the deploy and names the file", async () => {
  const root = await Deno.makeTempDir()
  try {
    await assertRejects(() => fillCatalogFiles(root, VALUES), Error, "traefik_config.yml")
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
