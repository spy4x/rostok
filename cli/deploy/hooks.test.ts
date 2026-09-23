import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { join, toFileUrl } from "@std/path"
import { UserError } from "../errors.ts"
import { buildHookEnv, type HookContext, isDeniedEnvKey, runHook } from "./hooks.ts"
import {
  killActiveChildren,
  setsidAvailable,
  supportsProcessGroupKill,
  trackChild,
} from "./process-registry.ts"

// `test-stack`'s own prefix (stackKeyPrefix) is TEST_STACK_ — DOMAIN is
// a real SERVER_KEYS entry. Both are allowed through by the new #217
// allowlist; ROOT_KEY/SERVER_KEY (arbitrary names) are not, so real
// keys stand in for them here.
const BASE_CTX: HookContext = {
  rootEnv: { DOMAIN: "example.com" },
  serverEnv: { TEST_STACK_TOKEN: "server-value" },
  envPath: "servers/test/.env",
  rootEnvPath: ".env.root",
  sshAddress: "root@example.com",
  sshUser: "deploy",
  pathApps: "/srv/apps",
  deployAs: "test-stack",
}
const STACK_NAME = "test-stack"

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
 * can't tell whether the allowlist/deny-list actually fired: Option B
 * alone would already keep the real value safe either way. Clearing
 * the ambient value first makes the test exercise the drop logic
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

/** True if a real `git` binary is on PATH — the GIT_CONFIG_* test below needs one. */
const gitAvailable = await new Deno.Command("git", {
  args: ["--version"],
  stdout: "null",
  stderr: "null",
}).output().then((o) => o.success).catch(() => false)

Deno.test("runHook: no-op when source is undefined", async () => {
  await withDirs(async (stagingDir) => {
    // Should not throw and should not touch the staging dir.
    await runHook("before", STACK_NAME, undefined, stagingDir, BASE_CTX)
    const entries = [...Deno.readDirSync(stagingDir)]
    assertEquals(entries.length, 0)
  })
})

Deno.test("runHook: runs from cwd=staging with allowed .env.root/.env keys + contract keys in env", async () => {
  await withDirs(async (stagingDir, hookDir) => {
    const hookPath = join(hookDir, "before.deploy.ts")
    await Deno.writeTextFile(
      hookPath,
      `await Deno.writeTextFile("hook-ran.json", JSON.stringify({ env: Deno.env.toObject() }))\n`,
    )

    await runHook("before", STACK_NAME, toFileUrl(hookPath).href, stagingDir, BASE_CTX)

    const written = JSON.parse(await Deno.readTextFile(join(stagingDir, "hook-ran.json")))
    assertEquals(written.env.DOMAIN, "example.com")
    assertEquals(written.env.TEST_STACK_TOKEN, "server-value")
    assertEquals(written.env.SSH_ADDRESS, "root@example.com")
    assertEquals(written.env.SSH_USER, "deploy")
    assertEquals(written.env.PATH_APPS, "/srv/apps")
    assertEquals(written.env.DEPLOY_AS, "test-stack")
  })
})

Deno.test("isDeniedEnvKey: covers LD_/NPM_CONFIG_/DENO_/NODE_ (#7 — restoring coverage for the deny-list prefixes)", () => {
  assert(isDeniedEnvKey("LD_PRELOAD"))
  assert(isDeniedEnvKey("NPM_CONFIG_REGISTRY"))
  assert(isDeniedEnvKey("DENO_DIR"))
  assert(isDeniedEnvKey("NODE_OPTIONS"))
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
  const { env, warnings } = buildHookEnv(ctx, STACK_NAME, processEnv)
  assertEquals(env.PATH, "/real/bin")
  assertEquals(env.HOME, "/real/home")
  assertEquals(env.DENO_DIR, "/real/deno-cache")
  assertEquals(warnings, [])
})

Deno.test("buildHookEnv: precedence — a parent GIT_SSH_COMMAND beats a .env one (denied name)", () => {
  const ctx: HookContext = {
    ...BASE_CTX,
    rootEnv: { ...BASE_CTX.rootEnv, GIT_SSH_COMMAND: "/tmp/evil-git-ssh" },
  }
  const { env } = buildHookEnv(ctx, STACK_NAME, { GIT_SSH_COMMAND: "/real/git-ssh-wrapper" })
  assertEquals(env.GIT_SSH_COMMAND, "/real/git-ssh-wrapper")
})

Deno.test("buildHookEnv: precedence — a .env DOMAIN beats a parent DOMAIN (allowed key)", () => {
  // #217's second precedence pass: for an ALLOWED key (a server key, or
  // the hook's own stack's prefix), the .env value is authoritative —
  // a shell that happens to export DOMAIN (or PROJECT, or the stack's
  // own TEST_STACK_TOKEN) must not silently override what deploy
  // itself resolved for that server.
  const ctx: HookContext = {
    ...BASE_CTX,
    rootEnv: { ...BASE_CTX.rootEnv, DOMAIN: "real-server.example" },
  }
  const { env, warnings } = buildHookEnv(ctx, STACK_NAME, { DOMAIN: "attacker-shell-value" })
  assertEquals(env.DOMAIN, "real-server.example")
  assertEquals(warnings, [])
})

Deno.test("buildHookEnv: an unprefixed, unknown .env key is dropped, with a warning naming the file", () => {
  // The new model (#217, second pass): a key from .env/.env.root only
  // reaches the hook if it's a server key or carries the hook's own
  // stack's prefix. RANDOM_UNKNOWN_KEY is neither.
  const ctx: HookContext = {
    ...BASE_CTX,
    serverEnv: { ...BASE_CTX.serverEnv, RANDOM_UNKNOWN_KEY: "whatever" },
  }
  const { env, warnings } = buildHookEnv(ctx, STACK_NAME, {})
  assertEquals("RANDOM_UNKNOWN_KEY" in env, false)
  // Prefix-mismatch drops collapse into one line per hook run (#7),
  // naming the file, the stack and every dropped key — not one line
  // per key.
  assertEquals(warnings.length, 1)
  assertStringIncludes(warnings[0], "RANDOM_UNKNOWN_KEY")
  assertStringIncludes(warnings[0], ctx.envPath)
  assertStringIncludes(warnings[0], "not meant for stack")
})

Deno.test("buildHookEnv: a key carrying the stack's own prefix is let through — the prefix half of the allowlist", () => {
  // Isolates the "carries the stack's own prefix" branch from
  // "is a server key": TEST_STACK_TOKEN is neither a SERVER_KEYS entry
  // nor a PATH_* key, so this only passes if the prefix check runs.
  const { env, warnings } = buildHookEnv(BASE_CTX, STACK_NAME, {})
  assertEquals(env.TEST_STACK_TOKEN, "server-value")
  assertEquals(warnings, [])
})

Deno.test("buildHookEnv: a key that's neither a plain shell name nor free of stray characters is dropped", () => {
  // A key carrying the stack's own prefix but with an unsafe character
  // in it (here a `;`, as a stand-in for anything that isn't a plain
  // identifier) must still be dropped — the allowlist isn't just a
  // prefix match, the whole key has to be a plain shell name.
  const ctx: HookContext = {
    ...BASE_CTX,
    serverEnv: { ...BASE_CTX.serverEnv, "TEST_STACK_FOO;evil": "value" },
  }
  const { env, warnings } = buildHookEnv(ctx, STACK_NAME, {})
  assertEquals("TEST_STACK_FOO;evil" in env, false)
  assertEquals(warnings.some((w) => w.includes("TEST_STACK_FOO;evil")), true)
})

Deno.test("buildHookEnv: the deny-list backstop drops a key even if it matches the stack's own prefix", () => {
  // A stack literally named "ld" has stackKeyPrefix "LD_" — without the
  // backstop running BEFORE the allowlist check, LD_PRELOAD would pass
  // as "carries the stack's own prefix".
  const ctx: HookContext = {
    ...BASE_CTX,
    serverEnv: { LD_PRELOAD: "/tmp/evil.so" },
  }
  const { env, warnings } = buildHookEnv(ctx, "ld", {})
  assertEquals("LD_PRELOAD" in env, false)
  assertEquals(warnings.length, 1)
  assertStringIncludes(warnings[0], "LD_PRELOAD")
  assertStringIncludes(warnings[0], "always denied")
})

Deno.test("buildHookEnv: names/prefixes .env can't run code via, each dropped with its own warning naming the file (#217)", () => {
  // The gap the first pass of #217 found: a deny-list of names
  // ("PATH, HOME, LD_*, ...") missed BASH_ENV/SSH_ASKPASS*/
  // GIT_SSH_COMMAND/RSYNC_RSH/PERL5*/PYTHONPATH — none of which the
  // deploy process normally sets, so "the process's own value wins"
  // alone (Option B) wouldn't drop them.
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
  const { env, warnings } = buildHookEnv(ctx, STACK_NAME, {})

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
        await runHook("before", STACK_NAME, toFileUrl(hookPath).href, stagingDir, ctx)
      } finally {
        console.error = originalConsoleError
      }

      const markerExists = await Deno.stat(markerPath).then(() => true).catch(() => false)
      assertEquals(markerExists, false, "BASH_ENV from .env ran inside the hook's own bash call")
    })
  })
})

Deno.test(
  "runHook: BASH_FUNC_true%%=touch marker from .env can't shadow a builtin when the hook starts bash (#217)",
  async () => {
    // Shellshock-era mechanism: bash imports a variable named
    // `BASH_FUNC_<name>%%` from its environment as a function
    // definition for <name>, shadowing any builtin/command of that
    // name. A hook that runs `bash -c "true"` would silently run the
    // attacker's function body instead of the real `true` builtin.
    await withoutAmbientEnv(["BASH_FUNC_true%%"], async () => {
      await withDirs(async (stagingDir, hookDir) => {
        const markerPath = join(hookDir, "marker")

        const hookPath = join(hookDir, "before.deploy.ts")
        await Deno.writeTextFile(
          hookPath,
          `const result = await new Deno.Command("bash", { args: ["-c", "true"] }).output()\n` +
            `if (!result.success) Deno.exit(1)\n`,
        )

        const ctx: HookContext = {
          ...BASE_CTX,
          serverEnv: {
            ...BASE_CTX.serverEnv,
            "BASH_FUNC_true%%": `() { touch '${markerPath}'\n}`,
          },
        }
        const originalConsoleError = console.error
        console.error = () => {}
        try {
          await runHook("before", STACK_NAME, toFileUrl(hookPath).href, stagingDir, ctx)
        } finally {
          console.error = originalConsoleError
        }

        const markerExists = await Deno.stat(markerPath).then(() => true).catch(() => false)
        assertEquals(
          markerExists,
          false,
          "BASH_FUNC_true%% from .env shadowed `true` inside the hook's own bash call",
        )
      })
    })
  },
)

Deno.test(
  "runHook: SHELLOPTS=xtrace + PS4='$(touch marker)' from .env can't run code when the hook starts bash (#217)",
  async () => {
    // With `set -x` (xtrace) active, bash evaluates PS4 — including a
    // command substitution inside it — before printing each traced
    // line. SHELLOPTS=xtrace turns tracing on for every bash invocation
    // without an explicit `set -x` in the script itself.
    await withoutAmbientEnv(["SHELLOPTS", "PS4"], async () => {
      await withDirs(async (stagingDir, hookDir) => {
        const markerPath = join(hookDir, "marker")

        const hookPath = join(hookDir, "before.deploy.ts")
        await Deno.writeTextFile(
          hookPath,
          `const result = await new Deno.Command("bash", { args: ["-c", "echo hi"] }).output()\n` +
            `if (!result.success) Deno.exit(1)\n`,
        )

        const ctx: HookContext = {
          ...BASE_CTX,
          serverEnv: {
            ...BASE_CTX.serverEnv,
            SHELLOPTS: "xtrace",
            PS4: `$(touch '${markerPath}')`,
          },
        }
        const originalConsoleError = console.error
        console.error = () => {}
        try {
          await runHook("before", STACK_NAME, toFileUrl(hookPath).href, stagingDir, ctx)
        } finally {
          console.error = originalConsoleError
        }

        const markerExists = await Deno.stat(markerPath).then(() => true).catch(() => false)
        assertEquals(
          markerExists,
          false,
          "SHELLOPTS/PS4 from .env ran inside the hook's own bash call",
        )
      })
    })
  },
)

Deno.test(
  "runHook: GIT_CONFIG_COUNT/KEY_0/VALUE_0 from .env can't run code via git's core.sshCommand (#217)",
  async () => {
    // AGENTS.md: a test that can silently skip when its dependency is
    // missing must fail loudly instead — git is expected on every dev
    // machine and CI image this repo runs on.
    if (!gitAvailable) {
      throw new Error(
        "git is not installed on this machine — this test needs a real git binary and must not silently skip",
      )
    }
    // Git's environment-based config override (GIT_CONFIG_COUNT +
    // GIT_CONFIG_KEY_<n>/VALUE_<n>, git >= 2.31) can set core.sshCommand,
    // which git runs IN PLACE OF ssh for any ssh:// transport — no
    // network access needed to prove it fires, since git substitutes it
    // before ever trying to resolve the host.
    await withoutAmbientEnv(
      ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"],
      async () => {
        await withDirs(async (stagingDir, hookDir) => {
          const markerPath = join(hookDir, "marker")

          const hookPath = join(hookDir, "before.deploy.ts")
          await Deno.writeTextFile(
            hookPath,
            `await new Deno.Command("git", { ` +
              `args: ["ls-remote", "ssh://example.invalid/x.git"], ` +
              `stdout: "null", stderr: "null" }).output()\n`,
          )

          const ctx: HookContext = {
            ...BASE_CTX,
            serverEnv: {
              ...BASE_CTX.serverEnv,
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "core.sshCommand",
              GIT_CONFIG_VALUE_0: `touch ${markerPath}`,
            },
          }
          const originalConsoleError = console.error
          console.error = () => {}
          try {
            await runHook("before", STACK_NAME, toFileUrl(hookPath).href, stagingDir, ctx)
          } finally {
            console.error = originalConsoleError
          }

          const markerExists = await Deno.stat(markerPath).then(() => true).catch(() => false)
          assertEquals(
            markerExists,
            false,
            "GIT_CONFIG_* from .env set core.sshCommand inside the hook's own git call",
          )
        })
      },
    )
  },
)

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
          await runHook("before", STACK_NAME, toFileUrl(hookPath).href, stagingDir, ctx)
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

/**
 * True if a process with this pid still exists: signal 0 isn't exposed
 * by Deno, so send SIGCONT, which is harmless to a running process and
 * fails with NotFound once the pid is gone. Needs no external tool (the
 * CI image has no `ps`).
 */
function isPidAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT")
    return true
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false
    throw err
  }
}

/**
 * Poll `isPidAlive` for up to `ms`: a killed process can linger as a
 * zombie for a moment until its new parent reaps it, and a zombie still
 * accepts signals. True if the pid is still there after the wait.
 */
async function isPidAliveAfter(pid: number, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (isPidAlive(pid)) {
    if (Date.now() > deadline) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

const canGroupKill = supportsProcessGroupKill() && await setsidAvailable()

Deno.test({
  name:
    "runHook: killActiveChildren also kills a long-lived grandchild the hook itself spawned (#3)",
  // Process-group kill needs both setsid on PATH and Deno.kill accepting
  // a negative pid — when either is missing, run-deploy.ts falls back
  // to signalling the hook process alone (see hooks.ts/process-registry.ts
  // and docs/contributing/adding-services.md's "must forward
  // termination" contract clause), which this specific test can't
  // observe without a hook that itself forwards SIGTERM — not a gap in
  // rostok's own code, so skip rather than fail here.
  ignore: !canGroupKill,
  fn: async () => {
    await withDirs(async (stagingDir, hookDir) => {
      const pidFile = join(hookDir, "child.pid")
      const hookPath = join(hookDir, "before.deploy.ts")
      await Deno.writeTextFile(
        hookPath,
        `const child = new Deno.Command("sleep", { args: ["30"] }).spawn()\n` +
          `await Deno.writeTextFile(${JSON.stringify(pidFile)}, String(child.pid))\n` +
          `await new Promise(() => {})\n`,
      )

      const runPromise = runHook(
        "before",
        STACK_NAME,
        toFileUrl(hookPath).href,
        stagingDir,
        BASE_CTX,
      )

      let childPid: number | undefined
      for (let i = 0; i < 250 && childPid === undefined; i++) {
        const text = await Deno.readTextFile(pidFile).catch(() => "")
        if (text.trim()) childPid = Number(text.trim())
        else await new Promise((r) => setTimeout(r, 20))
      }
      if (childPid === undefined) {
        throw new Error("the hook never recorded its long-lived child's pid")
      }

      killActiveChildren()
      await runPromise.catch(() => {}) // the hook process itself is killed too

      const stillAlive = await isPidAliveAfter(childPid)
      assertEquals(
        stillAlive,
        false,
        "the hook's long-lived grandchild survived killActiveChildren",
      )
    })
  },
})

Deno.test("runHook: throws UserError naming the stack when the hook exits non-zero", async () => {
  await withDirs(async (stagingDir, hookDir) => {
    const hookPath = join(hookDir, "before.deploy.ts")
    await Deno.writeTextFile(hookPath, `Deno.exit(1)\n`)

    const err = await assertRejects(
      () => runHook("before", STACK_NAME, toFileUrl(hookPath).href, stagingDir, BASE_CTX),
      UserError,
    )
    assertEquals(err.message.includes("test-stack"), true)
    assertEquals(err.message.includes("before.deploy.ts"), true)
  })
})

Deno.test("buildHookEnv: dropped keys collapse into one warning with control characters stripped", () => {
  const ctx: HookContext = {
    ...BASE_CTX,
    serverEnv: { "EVIL\x1b[31mKEY": "x", OTHER_STACK_KEY: "y" },
  }
  const { warnings } = buildHookEnv(ctx, STACK_NAME, {})
  assertEquals(warnings.length, 1, warnings.join("\n"))
  assertStringIncludes(warnings[0], "OTHER_STACK_KEY")
  assertStringIncludes(warnings[0], "EVIL")
  const controlChars = [...warnings[0]].filter((c) => c.charCodeAt(0) < 0x20 || c === "\x7f")
  assertEquals(controlChars, [], JSON.stringify(warnings[0]))
})

Deno.test("buildHookEnv: contract keys beat both a .env value and the parent environment", () => {
  const ctx: HookContext = {
    ...BASE_CTX,
    serverEnv: { SSH_ADDRESS: "evil@example.net", PATH_APPS: "/tmp/evil" },
  }
  const { env } = buildHookEnv(ctx, STACK_NAME, { SSH_USER: "shell-user", DEPLOY_AS: "shell" })
  assertEquals(env.SSH_ADDRESS, BASE_CTX.sshAddress)
  assertEquals(env.PATH_APPS, BASE_CTX.pathApps)
  assertEquals(env.SSH_USER, BASE_CTX.sshUser)
  assertEquals(env.DEPLOY_AS, BASE_CTX.deployAs)
})

Deno.test("buildHookEnv: JSR_URL from .env never reaches a hook, even for a stack named jsr", () => {
  const ctx: HookContext = { ...BASE_CTX, serverEnv: { JSR_URL: "http://127.0.0.1:9/" } }
  const { env, warnings } = buildHookEnv(ctx, "jsr", {})
  assertEquals(env.JSR_URL, undefined)
  assertStringIncludes(warnings.join("\n"), "JSR_URL")
})

Deno.test("killActiveChildren: SIGKILLs a child that ignores SIGTERM", async () => {
  // `trap "" TERM` makes the shell and the sleep it execs ignore SIGTERM,
  // so only the SIGKILL that follows the grace period can end it.
  const child = new Deno.Command("sh", {
    args: ["-c", `trap "" TERM; exec sleep 30`],
    stdout: "null",
    stderr: "null",
  }).spawn()
  trackChild(child)
  try {
    await new Promise((r) => setTimeout(r, 200)) // let the trap install
    killActiveChildren()
    const status = await Promise.race([
      child.status,
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ])
    assert(status !== null, "the SIGTERM-ignoring child was still running 3 s later")
    assertEquals(status.signal, "SIGKILL")
  } finally {
    try {
      child.kill("SIGKILL")
    } catch {
      // Already gone.
    }
    await child.status
  }
})

Deno.test("killActiveChildren: gives a child the grace period to exit on SIGTERM before SIGKILL", async () => {
  // The child exits cleanly on SIGTERM. Without the grace period, the
  // SIGKILL that follows at once would end it first.
  const child = new Deno.Command("sh", {
    args: ["-c", `trap 'kill $! 2>/dev/null; exit 0' TERM; sleep 30 & wait`],
    stdout: "null",
    stderr: "null",
  }).spawn()
  trackChild(child)
  try {
    await new Promise((r) => setTimeout(r, 200)) // let the trap install
    killActiveChildren()
    const status = await child.status
    assertEquals(status.signal, null, "the child was killed before it could exit on SIGTERM")
    assertEquals(status.code, 0)
  } finally {
    try {
      child.kill("SIGKILL")
    } catch {
      // Already gone.
    }
  }
})
