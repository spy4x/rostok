import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { UserError } from "../errors.ts"
import { checkDockerGroup, needsRemoteSudo } from "./docker-preflight.ts"

/** Install a fake `ssh` on PATH that prints `sshReply` to stdout and exits 0. */
async function withFakeSsh<T>(sshReply: string, fn: () => Promise<T>): Promise<T> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-ssh-" })
  try {
    const script = `#!/bin/sh\nprintf '%s' ${shQuote(sshReply)}\n`
    await Deno.writeTextFile(join(binDir, "ssh"), script, { mode: 0o755 })
    const previousPath = Deno.env.get("PATH") ?? ""
    Deno.env.set("PATH", `${binDir}:${previousPath}`)
    try {
      return await fn()
    } finally {
      Deno.env.set("PATH", previousPath)
    }
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

Deno.test("checkDockerGroup: passes when the remote GID matches", async () => {
  await withFakeSsh("docker:x:988:\n", async () => {
    await checkDockerGroup("root@example.com", "988", "servers/home/.env")
  })
})

Deno.test("checkDockerGroup: throws naming both GIDs and the file on mismatch", async () => {
  await withFakeSsh("docker:x:988:\n", async () => {
    const err = await assertRejects(
      () => checkDockerGroup("root@example.com", "990", "servers/home/.env"),
      UserError,
    )
    assertStringIncludes(err.message, "990")
    assertStringIncludes(err.message, "988")
    assertStringIncludes(err.message, "servers/home/.env")
  })
})

Deno.test("checkDockerGroup: throws when the docker group is missing", async () => {
  await withFakeSsh("", async () => {
    const err = await assertRejects(
      () => checkDockerGroup("root@example.com", "988", "servers/home/.env"),
      UserError,
    )
    assertStringIncludes(err.message, "docker group not found")
  })
})

Deno.test("needsRemoteSudo: false when the remote id -u is 0 (already root)", async () => {
  await withFakeSsh("0\n", async () => {
    const result = await needsRemoteSudo("root@example.com")
    assertEquals(result, false)
  })
})

Deno.test("needsRemoteSudo: true when the remote id -u is not 0", async () => {
  await withFakeSsh("1000\n", async () => {
    const result = await needsRemoteSudo("deploy@example.com")
    assertEquals(result, true)
  })
})

Deno.test("needsRemoteSudo: throws when id -u can't be read", async () => {
  await withFakeSsh("", async () => {
    const err = await assertRejects(
      () => needsRemoteSudo("root@example.com"),
      UserError,
    )
    assertStringIncludes(err.message, "id -u")
  })
})
