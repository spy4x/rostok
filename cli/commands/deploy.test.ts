// Tests for cli/commands/deploy.ts — pre-flight validation.
//
// We test validateDeployArgs directly (the pure-function layer). The
// cliffy wrapper just calls it + exits, which is exercised by the
// --help test in cli/+main.test.ts.

import { assertEquals, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { validateDeployArgs } from "./deploy.ts"

async function fixture(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "rostok-deploy-" })
}

Deno.test("validateDeployArgs: ok when server exists + stack arg matches", async () => {
  const tmp = await fixture()
  try {
    await Deno.mkdir(join(tmp, "servers", "home"), { recursive: true })
    await Deno.writeTextFile(join(tmp, "servers", "home", ".env"), "FOO=bar\n")
    await Deno.writeTextFile(
      join(tmp, "servers", "home", "config.json"),
      JSON.stringify({ stacks: [{ name: "traefik" }, { name: "gatus" }] }),
    )
    const result = await validateDeployArgs(tmp, "home", "traefik")
    assertEquals(result.ok, true)
    assertEquals(result.availableStacks, ["traefik", "gatus"])
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("validateDeployArgs: ok when server exists + no stack arg (deploy all)", async () => {
  const tmp = await fixture()
  try {
    await Deno.mkdir(join(tmp, "servers", "home"), { recursive: true })
    await Deno.writeTextFile(join(tmp, "servers", "home", ".env"), "")
    await Deno.writeTextFile(
      join(tmp, "servers", "home", "config.json"),
      JSON.stringify({ stacks: [{ name: "traefik" }] }),
    )
    const result = await validateDeployArgs(tmp, "home", undefined)
    assertEquals(result.ok, true)
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("validateDeployArgs: error when servers/<server>/ is missing", async () => {
  const tmp = await fixture()
  try {
    const result = await validateDeployArgs(tmp, "home", undefined)
    assertEquals(result.ok, false)
    assertStringIncludes(result.error ?? "", "server 'home' not found")
    assertStringIncludes(result.error ?? "", "rostok server create")
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("validateDeployArgs: error when .env is missing in server dir", async () => {
  const tmp = await fixture()
  try {
    await Deno.mkdir(join(tmp, "servers", "home"), { recursive: true })
    // No .env file.
    const result = await validateDeployArgs(tmp, "home", undefined)
    assertEquals(result.ok, false)
    assertStringIncludes(result.error ?? "", "server 'home' not found")
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("validateDeployArgs: error when config.json is missing", async () => {
  const tmp = await fixture()
  try {
    await Deno.mkdir(join(tmp, "servers", "home"), { recursive: true })
    await Deno.writeTextFile(join(tmp, "servers", "home", ".env"), "")
    const result = await validateDeployArgs(tmp, "home", undefined)
    assertEquals(result.ok, false)
    assertStringIncludes(result.error ?? "", "config.json missing")
    assertStringIncludes(result.error ?? "", "rostok stack add")
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("validateDeployArgs: error when config.json has no stacks", async () => {
  const tmp = await fixture()
  try {
    await Deno.mkdir(join(tmp, "servers", "home"), { recursive: true })
    await Deno.writeTextFile(join(tmp, "servers", "home", ".env"), "")
    await Deno.writeTextFile(
      join(tmp, "servers", "home", "config.json"),
      JSON.stringify({ stacks: [] }),
    )
    const result = await validateDeployArgs(tmp, "home", undefined)
    assertEquals(result.ok, false)
    assertStringIncludes(result.error ?? "", "no stacks")
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("validateDeployArgs: error when requested stack not in config.json", async () => {
  const tmp = await fixture()
  try {
    await Deno.mkdir(join(tmp, "servers", "home"), { recursive: true })
    await Deno.writeTextFile(join(tmp, "servers", "home", ".env"), "")
    await Deno.writeTextFile(
      join(tmp, "servers", "home", "config.json"),
      JSON.stringify({ stacks: [{ name: "traefik" }] }),
    )
    const result = await validateDeployArgs(tmp, "home", "ghost")
    assertEquals(result.ok, false)
    assertStringIncludes(result.error ?? "", "stack 'ghost' not found")
    assertStringIncludes(result.error ?? "", "traefik") // lists available
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("validateDeployArgs: error when config.json is malformed JSON", async () => {
  const tmp = await fixture()
  try {
    await Deno.mkdir(join(tmp, "servers", "home"), { recursive: true })
    await Deno.writeTextFile(join(tmp, "servers", "home", ".env"), "")
    await Deno.writeTextFile(
      join(tmp, "servers", "home", "config.json"),
      "{ this is not json",
    )
    const result = await validateDeployArgs(tmp, "home", undefined)
    assertEquals(result.ok, false)
    assertStringIncludes(result.error ?? "", "not valid JSON")
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})
