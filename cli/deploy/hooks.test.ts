import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { join, toFileUrl } from "@std/path"
import { UserError } from "../errors.ts"
import { buildHookEnv, type HookContext, runHook } from "./hooks.ts"

const BASE_CTX: HookContext = {
  rootEnv: { ROOT_KEY: "root-value" },
  serverEnv: { SERVER_KEY: "server-value" },
  envPath: "servers/test/.env",
  rootEnvPath: ".env.root",
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

/**
 * Delete `keys` from this test process's own environment for the
 * duration of `fn`, restoring whatever was there afterward. #217's
 * Option B means the deploy process's own real value for a name always
 * wins — correctly — so a test that leaves an ambient SSH_ASKPASS (a
 * desktop dev box often has one, e.g. ksshaskpass) or BASH_ENV in place
 * can't tell whether the deny-list backstop actually fired: Option B
 * alone would already keep the real value safe either way. Clearing
 * the ambient value first makes the test exercise the backstop
 * specifically, deterministically, on any machine.
 */
async function withoutAmbientEnv(keys: string[], fn: () => Promise<void>): Promise<void> {
  const previous = new Map(keys.map((k) => [k, Deno.env.get(k)]))
  for (const k of keys) Deno.env.delete(k)
  try {
    await fn()
  } finally {
    for (const [k, v] of previous) {
      if (v === undefined) Deno.env.delete(k)
      else Deno.env.set(k, v)
    }
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

Deno.test("buildHookEnv: the process's own PATH/HOME/DENO_*/etc. always win, silently — no warning needed", () => {
  // #217 option B: for a name the deploy process already has, its real
  // value wins the moment it's spread on top of the file-sourced env —
  // no warning, because nothing malicious got through. This is true
  // whether or not .env/.env.root also set that name.
  const processEnv = {
    PATH: "/real/bin",
    HOME: "/real/home",
    DENO_DIR: "/real/deno-cache",
  }
  const ctx: HookContext = {
    ...BASE_CTX,
    serverEnv: {
      ...BASE_CTX.serverEnv,
      PATH: "/tmp/evil-bin",
      HOME: "/tmp/evil-home",
      DENO_DIR: "/tmp/evil-deno-cache",
    },
  }
  const { env, warnings } = buildHookEnv(ctx, processEnv)
  assertEquals(env.PATH, "/real/bin")
  assertEquals(env.HOME, "/real/home")
  assertEquals(env.DENO_DIR, "/real/deno-cache")
  assertEquals(warnings, [])
})

Deno.test("buildHookEnv: a name the process never set is dropped, with its own warning naming the file (#217)", () => {
  // The gap #217 found: a deny-list of names ("PATH, HOME, LD_*, ...")
  // missed BASH_ENV/SSH_ASKPASS*/GIT_SSH_COMMAND/RSYNC_RSH/PERL5*/
  // PYTHONPATH — none of which the deploy process normally sets, so
  // "the process's own value wins" alone (Option B) wouldn't drop
  // them. Each still needs an explicit backstop.
  const ctx: HookContext = {
    ...BASE_CTX,
    rootEnv: { ...BASE_CTX.rootEnv, GIT_SSH_COMMAND: "/tmp/evil-git-ssh" },
    serverEnv: {
      ...BASE_CTX.serverEnv,
      BASH_ENV: "/tmp/evil.sh",
      SSH_ASKPASS: "/tmp/evil-askpass",
      SSH_ASKPASS_REQUIRE: "force",
    },
  }
  // processEnv deliberately has none of these set.
  const { env, warnings } = buildHookEnv(ctx, {})

  assertEquals("BASH_ENV" in env, false)
  assertEquals("SSH_ASKPASS" in env, false)
  assertEquals("SSH_ASKPASS_REQUIRE" in env, false)
  assertEquals("GIT_SSH_COMMAND" in env, false)

  assertEquals(warnings.length, 4)
  const byKey = (key: string) => warnings.find((w) => w.includes(key))
  assertStringIncludes(byKey("BASH_ENV") ?? "", ctx.envPath)
  assertStringIncludes(byKey("SSH_ASKPASS_REQUIRE") ?? "", ctx.envPath)
  assertStringIncludes(byKey("SSH_ASKPASS") ?? "", ctx.envPath)
  // GIT_SSH_COMMAND came from rootEnv, not serverEnv — the warning must
  // name .env.root, not the server .env.
  assertStringIncludes(byKey("GIT_SSH_COMMAND") ?? "", ctx.rootEnvPath)
})

Deno.test("runHook: BASH_ENV from .env can't run code when the hook itself starts bash (#217)", async () => {
  // Real proof, not just an env-value check: the hook spawns bash for
  // its own purposes (a common thing for a deploy hook to do), and
  // BASH_ENV from a shared .env must not run on that call.
  await withoutAmbientEnv(["BASH_ENV"], async () => {
    await withDirs(async (stagingDir, hookDir) => {
      const markerPath = join(hookDir, "marker")
      const bashEnvScript = join(hookDir, "bash-env.sh")
      await Deno.writeTextFile(bashEnvScript, `touch '${markerPath}'\n`)

      const hookPath = join(hookDir, "before.deploy.ts")
      await Deno.writeTextFile(
        hookPath,
        `const result = await new Deno.Command("bash", { args: ["-c", "true"] }).output()\n` +
          `if (!result.success) Deno.exit(1)\n`,
      )

      const ctx: HookContext = {
        ...BASE_CTX,
        serverEnv: { ...BASE_CTX.serverEnv, BASH_ENV: bashEnvScript },
      }
      const originalConsoleError = console.error
      console.error = () => {}
      try {
        await runHook("before", "test-stack", toFileUrl(hookPath).href, stagingDir, ctx)
      } finally {
        console.error = originalConsoleError
      }

      const markerExists = await Deno.stat(markerPath).then(() => true).catch(() => false)
      assertEquals(markerExists, false, "BASH_ENV from .env ran inside the hook's own bash call")
    })
  })
})

Deno.test(
  "runHook: SSH_ASKPASS + SSH_ASKPASS_REQUIRE=force from .env can't run code when the hook starts ssh (#217)",
  async () => {
    // Simulates the one real trigger for SSH_ASKPASS: setting
    // SSH_ASKPASS_REQUIRE=force makes a real ssh client run SSH_ASKPASS
    // even with no controlling terminal — a fake `ssh` on PATH
    // reproduces exactly that check deterministically, without a real
    // sshd that demands password auth.
    await withoutAmbientEnv(["SSH_ASKPASS", "SSH_ASKPASS_REQUIRE"], async () => {
      await withDirs(async (stagingDir, hookDir) => {
        const markerPath = join(hookDir, "marker")
        const askpassPath = join(hookDir, "askpass")
        await Deno.writeTextFile(askpassPath, `#!/bin/sh\ntouch '${markerPath}'\n`, {
          mode: 0o755,
        })

        const binDir = join(hookDir, "bin")
        await Deno.mkdir(binDir)
        const fakeSshPath = join(binDir, "ssh")
        await Deno.writeTextFile(
          fakeSshPath,
          `#!/bin/sh\n` +
            `if [ "$SSH_ASKPASS_REQUIRE" = "force" ] && [ -n "$SSH_ASKPASS" ]; then "$SSH_ASKPASS"; fi\n` +
            `exit 0\n`,
          { mode: 0o755 },
        )

        const hookPath = join(hookDir, "before.deploy.ts")
        await Deno.writeTextFile(
          hookPath,
          `const result = await new Deno.Command("ssh", { args: ["--", "host", "true"] }).output()\n` +
            `if (!result.success) Deno.exit(1)\n`,
        )

        const ctx: HookContext = {
          ...BASE_CTX,
          serverEnv: {
            ...BASE_CTX.serverEnv,
            SSH_ASKPASS: askpassPath,
            SSH_ASKPASS_REQUIRE: "force",
          },
        }

        const previousPath = Deno.env.get("PATH") ?? ""
        Deno.env.set("PATH", `${binDir}:${previousPath}`)
        const originalConsoleError = console.error
        console.error = () => {}
        try {
          await runHook("before", "test-stack", toFileUrl(hookPath).href, stagingDir, ctx)
        } finally {
          console.error = originalConsoleError
          Deno.env.set("PATH", previousPath)
        }

        const markerExists = await Deno.stat(markerPath).then(() => true).catch(() => false)
        assertEquals(markerExists, false, "SSH_ASKPASS from .env ran inside the hook's ssh call")
      })
    })
  },
)

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
