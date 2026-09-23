import { assertEquals, assertRejects } from "@std/assert"
import { join, toFileUrl } from "@std/path"
import { UserError } from "../errors.ts"
import { runHook } from "./hooks.ts"

const BASE_CTX = {
  rootEnv: { ROOT_KEY: "root-value" },
  serverEnv: { SERVER_KEY: "server-value" },
  sshAddress: "root@example.com",
  sshUser: "deploy",
  pathApps: "/srv/apps",
  deployAs: "test-stack",
}

async function withDirs(fn: (stagingDir: string, hookDir: string) => Promise<void>) {
  const stagingDir = await Deno.makeTempDir({ prefix: "rostok-hook-staging-" })
  const hookDir = await Deno.makeTempDir({ prefix: "rostok-hook-source-" })
  try {
    await fn(stagingDir, hookDir)
  } finally {
    await Deno.remove(stagingDir, { recursive: true })
    await Deno.remove(hookDir, { recursive: true })
  }
}

Deno.test("runHook: no-op when source is undefined", async () => {
  await withDirs(async (stagingDir) => {
    // Should not throw and should not touch the staging dir.
    await runHook("before", "test-stack", undefined, stagingDir, BASE_CTX)
    const entries = [...Deno.readDirSync(stagingDir)]
    assertEquals(entries.length, 0)
  })
})

Deno.test("runHook: runs from cwd=staging with .env.root/.env keys + contract keys in env", async () => {
  await withDirs(async (stagingDir, hookDir) => {
    const hookPath = join(hookDir, "before.deploy.ts")
    await Deno.writeTextFile(
      hookPath,
      `await Deno.writeTextFile("hook-ran.json", JSON.stringify({ env: Deno.env.toObject() }))\n`,
    )

    await runHook("before", "test-stack", toFileUrl(hookPath).href, stagingDir, BASE_CTX)

    const written = JSON.parse(await Deno.readTextFile(join(stagingDir, "hook-ran.json")))
    assertEquals(written.env.ROOT_KEY, "root-value")
    assertEquals(written.env.SERVER_KEY, "server-value")
    assertEquals(written.env.SSH_ADDRESS, "root@example.com")
    assertEquals(written.env.SSH_USER, "deploy")
    assertEquals(written.env.PATH_APPS, "/srv/apps")
    assertEquals(written.env.DEPLOY_AS, "test-stack")
  })
})

Deno.test("runHook: throws UserError naming the stack when the hook exits non-zero", async () => {
  await withDirs(async (stagingDir, hookDir) => {
    const hookPath = join(hookDir, "before.deploy.ts")
    await Deno.writeTextFile(hookPath, `Deno.exit(1)\n`)

    const err = await assertRejects(
      () => runHook("before", "test-stack", toFileUrl(hookPath).href, stagingDir, BASE_CTX),
      UserError,
    )
    assertEquals(err.message.includes("test-stack"), true)
    assertEquals(err.message.includes("before.deploy.ts"), true)
  })
})
