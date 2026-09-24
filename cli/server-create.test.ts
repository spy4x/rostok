// Tests for cli/server-create.ts.
//
// Per the brief for #206/#207/#208/#209, every test that resolves an SSH
// target puts a fake `ssh` script first on PATH so the #207 probe never
// reaches a real network — it always runs (the target is always known
// once sshTarget is resolved), so this applies broadly, not just to the
// probe-specific tests below.

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { UserError } from "./errors.ts"
import { DEPLOY_REQUIRED_KEYS } from "./server-keys.ts"
import { readEnvFile } from "./env-files.ts"
import { probeServer, serverCreate } from "./server-create.ts"
import type { PromptBase } from "./prompts.ts"

/** Write a fake `ssh` on its own PATH entry, prepended for the duration of `fn`. */
async function withFakeSsh<T>(script: string, fn: () => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-fakessh-" })
  const scriptPath = join(dir, "ssh")
  await Deno.writeTextFile(scriptPath, script)
  await Deno.chmod(scriptPath, 0o755)
  const oldPath = Deno.env.get("PATH") ?? ""
  Deno.env.set("PATH", `${dir}${Deno.build.os === "windows" ? ";" : ":"}${oldPath}`)
  try {
    return await fn()
  } finally {
    Deno.env.set("PATH", oldPath)
    await Deno.remove(dir, { recursive: true })
  }
}

const OK_SSH = `#!/bin/sh
echo "DOCKER_GID=988"
echo "SSH_UID=1000"
echo "SSH_GID=1000"
`

const ROOT_SSH = `#!/bin/sh
echo "DOCKER_GID=988"
echo "SSH_UID=0"
echo "SSH_GID=0"
`

const NO_DOCKER_SSH = `#!/bin/sh
echo "SSH_UID=1000"
echo "SSH_GID=1000"
`

const FAILING_SSH = `#!/bin/sh
echo "Could not resolve hostname" >&2
exit 255
`

// Distinguishes the #207 probe command from the #212 timedatectl
// command by content, so one fake ssh script can answer both.
const OK_SSH_WITH_REMOTE_TIMEZONE = `#!/bin/sh
case "$*" in
  *timedatectl*)
    echo "Pacific/Kiritimati"
    ;;
  *)
    echo "DOCKER_GID=988"
    echo "SSH_UID=1000"
    echo "SSH_GID=1000"
    ;;
esac
`

const OK_SSH_WITH_USER = `#!/bin/sh
echo "DOCKER_GID=988"
echo "SSH_UID=1000"
echo "SSH_GID=1000"
echo "SSH_USER=remoteuser"
`

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-server-create-" })
  try {
    return await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {})
  }
}

// ─────────────────────────────────────────────────────────────────────
// #206 — contract test: only the required inputs, everything else from
// defaults / the SSH probe.
// ─────────────────────────────────────────────────────────────────────

Deno.test("server create with only required inputs writes a superset of DEPLOY_REQUIRED_KEYS", async () => {
  await withFakeSsh(OK_SSH, () =>
    withTmpDir(async (dir) => {
      const result = await serverCreate({
        cwd: dir,
        failFast: true,
        providedVars: {
          SERVER_NAME: "home",
          SSH_ADDRESS: "root@192.0.2.1",
          DOMAIN: "example.com",
          CONTACT_EMAIL: "a@example.com",
        },
      })
      const env = await readEnvFile(result.envPath)
      const keys = new Set(env.map((e) => e.key))
      for (const key of DEPLOY_REQUIRED_KEYS) {
        assertEquals(keys.has(key), true, `missing ${key}`)
      }
      // SSH_USER comes from the parsed `user@host` target.
      assertEquals(env.find((e) => e.key === "SSH_USER")?.value, "root")
      // PATH_APPS defaults to DEFAULT_PATH_APPS.
      assertEquals(env.find((e) => e.key === "PATH_APPS")?.value, "/srv/apps")
      // SERVER_NAME is the directory name — zond's compose.yml reads it
      // directly, and nothing wrote it before this key existed.
      assertEquals(env.find((e) => e.key === "SERVER_NAME")?.value, "home")
    }))
})

Deno.test("server create accepts legacy camelCase --var aliases", async () => {
  await withFakeSsh(OK_SSH, () =>
    withTmpDir(async (dir) => {
      const result = await serverCreate({
        cwd: dir,
        failFast: true,
        providedVars: {
          serverName: "home",
          sshTarget: "root@192.0.2.1",
          domain: "example.com",
          contactEmail: "a@example.com",
        },
      })
      assertEquals(result.serverName, "home")
    }))
})

// ─────────────────────────────────────────────────────────────────────
// #209 — user@host parsing: the parsed user is used without asking in
// non-interactive mode, and no longer throws a "doesn't include a user"
// error.
// ─────────────────────────────────────────────────────────────────────

Deno.test("server create uses the parsed user from user@host non-interactively", async () => {
  await withFakeSsh(OK_SSH, () =>
    withTmpDir(async (dir) => {
      const result = await serverCreate({
        cwd: dir,
        failFast: true,
        providedVars: {
          SERVER_NAME: "home",
          SSH_ADDRESS: "deploy@192.0.2.1",
          DOMAIN: "example.com",
          CONTACT_EMAIL: "a@example.com",
        },
      })
      assertEquals(result.parsedSsh.user, "deploy")
      const env = await readEnvFile(result.envPath)
      assertEquals(env.find((e) => e.key === "SSH_USER")?.value, "deploy")
    }))
})

Deno.test("server create: an explicit --var SSH_USER overrides the parsed user", async () => {
  await withFakeSsh(OK_SSH, () =>
    withTmpDir(async (dir) => {
      const result = await serverCreate({
        cwd: dir,
        failFast: true,
        providedVars: {
          SERVER_NAME: "home",
          SSH_ADDRESS: "deploy@192.0.2.1",
          SSH_USER: "override",
          DOMAIN: "example.com",
          CONTACT_EMAIL: "a@example.com",
        },
      })
      const env = await readEnvFile(result.envPath)
      assertEquals(env.find((e) => e.key === "SSH_USER")?.value, "override")
    }))
})

// ─────────────────────────────────────────────────────────────────────
// #209 — missing required values throw UserError naming the --var.
// ─────────────────────────────────────────────────────────────────────

Deno.test("server create: missing DOMAIN throws UserError naming --var DOMAIN", async () => {
  await withFakeSsh(OK_SSH, () =>
    withTmpDir(async (dir) => {
      await assertRejects(
        () =>
          serverCreate({
            cwd: dir,
            failFast: true,
            providedVars: {
              SERVER_NAME: "home",
              SSH_ADDRESS: "root@192.0.2.1",
              CONTACT_EMAIL: "a@example.com",
            },
          }),
        UserError,
        "missing DOMAIN: pass --var DOMAIN=",
      )
    }))
})

// ─────────────────────────────────────────────────────────────────────
// #208 — path traversal in the server name exits non-zero and writes
// nothing, before any prompt beyond the name itself.
// ─────────────────────────────────────────────────────────────────────

Deno.test("server create rejects a traversal server name and writes nothing", async () => {
  await withTmpDir(async (dir) => {
    await assertRejects(
      () =>
        serverCreate({
          cwd: dir,
          failFast: true,
          providedVars: {
            SERVER_NAME: "../escaped",
            SSH_ADDRESS: "root@192.0.2.1",
            DOMAIN: "example.com",
            CONTACT_EMAIL: "a@example.com",
          },
        }),
      UserError,
      "invalid server name",
    )
    const entries: string[] = []
    for await (const e of Deno.readDir(dir)) entries.push(e.name)
    assertEquals(entries, [], "server create must write nothing on a rejected name")
  })
})

// ─────────────────────────────────────────────────────────────────────
// Review fix #1 — re-running server create on an existing server with an
// alias target (no user in SSH_ADDRESS) keeps every existing value
// instead of resetting it to a static default. Regression: before the
// fix, a failed probe overwrote SSH_USER with the local `whoami` and
// reset a hand-corrected DOCKER_GROUP_ID back to 990.
// ─────────────────────────────────────────────────────────────────────

async function seedServerEnv(dir: string, name: string, text: string): Promise<void> {
  await Deno.mkdir(join(dir, "servers", name), { recursive: true })
  await Deno.writeTextFile(join(dir, "servers", name, ".env"), text)
}

Deno.test("re-running server create with an alias target keeps existing values (SSH_USER, DOCKER_GROUP_ID) instead of resetting them", async () => {
  // The probe fails (unreachable alias, the realistic case for a CI
  // sandbox) — every field must fall back to what's already in .env,
  // not the static defaults.
  await withFakeSsh(FAILING_SSH, () =>
    withTmpDir(async (dir) => {
      await seedServerEnv(
        dir,
        "home",
        [
          "PROJECT=hl",
          "SSH_ADDRESS=myhomelab",
          "SSH_USER=deploy",
          "DOMAIN=example.com",
          "CONTACT_EMAIL=a@example.com",
          "DOCKER_GROUP_ID=977", // hand-corrected — must survive a failed probe
          "TIMEZONE=UTC",
          "PUID=1000",
          "PGID=1000",
          "VOLUMES_PATH=/srv/volumes",
          "PATH_APPS=/srv/apps",
        ].join("\n") + "\n",
      )

      // Re-run with only the name supplied, exactly like a user re-running
      // `rostok server create home -n` to pick up one small change.
      const result = await serverCreate({
        cwd: dir,
        failFast: true,
        providedVars: { SERVER_NAME: "home" },
      })

      const env = await readEnvFile(result.envPath)
      assertEquals(
        env.find((e) => e.key === "SSH_USER")?.value,
        "deploy",
        "kept the existing SSH_USER instead of falling back to the local shell user",
      )
      assertEquals(
        env.find((e) => e.key === "DOCKER_GROUP_ID")?.value,
        "977",
        "kept the hand-corrected GID — the probe failed, so it must not reset to 990",
      )
    }))
})

Deno.test("a successful probe's docker GID wins over a stale existing value", async () => {
  await withFakeSsh(OK_SSH, () =>
    withTmpDir(async (dir) => {
      await seedServerEnv(
        dir,
        "home",
        "PROJECT=hl\nSSH_ADDRESS=myhomelab\nSSH_USER=deploy\nDOMAIN=example.com\n" +
          "CONTACT_EMAIL=a@example.com\nDOCKER_GROUP_ID=977\n",
      )
      const result = await serverCreate({
        cwd: dir,
        failFast: true,
        providedVars: { SERVER_NAME: "home" },
      })
      const env = await readEnvFile(result.envPath)
      // OK_SSH reports 988 — the fresh, successful probe result wins
      // over the stale 977 already in .env.
      assertEquals(env.find((e) => e.key === "DOCKER_GROUP_ID")?.value, "988")
    }))
})

// Review fix #1 (round 3) — a successful probe must NOT override a saved
// PUID/PGID (or any other hand-set field): unlike DOCKER_GROUP_ID,
// PUID/PGID aren't drift to correct, they're the ownership every volume
// on disk was already chowned to. Regression: re-running server create
// against a server that probes successfully as root rewrote PUID=1500
// to 1000, so the next deploy chowned existing data to a different user.
Deno.test("re-running server create with a successful probe keeps PUID/PGID and other hand-set fields", async () => {
  await withFakeSsh(ROOT_SSH, () =>
    withTmpDir(async (dir) => {
      await seedServerEnv(
        dir,
        "home",
        [
          "PROJECT=myproj",
          "SSH_ADDRESS=myhomelab",
          "SSH_USER=deploy",
          "DOMAIN=example.com",
          "CONTACT_EMAIL=a@example.com",
          "DOCKER_GROUP_ID=977",
          "TIMEZONE=Europe/Berlin",
          "PUID=1500",
          "PGID=1500",
          "VOLUMES_PATH=/custom/volumes",
          "PATH_APPS=/custom/apps",
        ].join("\n") + "\n",
      )

      const result = await serverCreate({
        cwd: dir,
        failFast: true,
        providedVars: { SERVER_NAME: "home" },
      })

      const env = await readEnvFile(result.envPath)
      const get = (k: string) => env.find((e) => e.key === k)?.value
      assertEquals(get("PROJECT"), "myproj")
      assertEquals(get("TIMEZONE"), "Europe/Berlin")
      assertEquals(get("PUID"), "1500", "a saved PUID must survive even a successful (root) probe")
      assertEquals(get("PGID"), "1500", "a saved PGID must survive even a successful (root) probe")
      assertEquals(get("VOLUMES_PATH"), "/custom/volumes")
      assertEquals(get("PATH_APPS"), "/custom/apps")
      // DOCKER_GROUP_ID is the one field that DOES follow a successful probe.
      assertEquals(get("DOCKER_GROUP_ID"), "988")
    }))
})

// ─────────────────────────────────────────────────────────────────────
// Review fix #2 — an alias target with no user anywhere (not provided,
// not already in .env) asks the server (`id -un`) instead of guessing
// the local shell user.
// ─────────────────────────────────────────────────────────────────────

Deno.test("server create asks the server for the remote username when an alias target has no known user", async () => {
  await withFakeSsh(OK_SSH_WITH_USER, () =>
    withTmpDir(async (dir) => {
      const result = await serverCreate({
        cwd: dir,
        failFast: true,
        providedVars: {
          SERVER_NAME: "home",
          SSH_ADDRESS: "myhomelab", // alias — no user in the target itself
          DOMAIN: "example.com",
          CONTACT_EMAIL: "a@example.com",
        },
      })
      const env = await readEnvFile(result.envPath)
      assertEquals(env.find((e) => e.key === "SSH_USER")?.value, "remoteuser")
    }))
})

// ─────────────────────────────────────────────────────────────────────
// Review fix — #212's "human label with the key in parentheses" claim
// was never actually driven through the interactive branch: every
// existing test either provides every field (skipping the prompt
// entirely) or runs non-interactively (which uses the label as an error
// suffix, not what the user sees). `promptFn` lets a test capture the
// exact label cliffy would show.
// ─────────────────────────────────────────────────────────────────────

Deno.test("server create: the interactive SSH target prompt's label carries (SSH_ADDRESS)", async () => {
  await withFakeSsh(OK_SSH, () =>
    withTmpDir(async (dir) => {
      const seen: PromptBase[] = []
      await serverCreate({
        cwd: dir,
        providedVars: {
          SERVER_NAME: "home",
          DOMAIN: "example.com",
          CONTACT_EMAIL: "a@example.com",
        },
        promptFn: (base) => {
          seen.push(base)
          if (base.message.includes("SSH target")) return Promise.resolve("root@192.0.2.1")
          // Every other field has a usable default (from the probe or a
          // static fallback) — accept it, same as pressing Enter would.
          return Promise.resolve(base.default ?? "x")
        },
      })
      const sshPrompt = seen.find((b) => b.message.includes("SSH_ADDRESS"))
      assertEquals(sshPrompt !== undefined, true, seen.map((b) => b.message).join("\n"))
      assertStringIncludes(sshPrompt!.message, "SSH target")
      assertStringIncludes(sshPrompt!.message, "(SSH_ADDRESS)")
    }))
})

// Review fix — nothing previously exercised the actual remote-timezone
// wiring end to end: server-create.ts wires `remote:
// sshReachable ? () => remoteTimedatectlTimezone(sshTarget) : undefined`
// into detectTimezone, but every existing test either had no fake ssh
// (probe fails, sshReachable false, remote never called) or never
// checked TIMEZONE's actual value. If that wiring were deleted (remote
// always undefined), this test's expectation — the server's own,
// deliberately weird zone, not whatever the CI machine's local Intl
// zone happens to be — would go red.
Deno.test("server create: TIMEZONE defaults to the server's own timedatectl answer, not the local machine's zone", async () => {
  await withFakeSsh(OK_SSH_WITH_REMOTE_TIMEZONE, () =>
    withTmpDir(async (dir) => {
      const result = await serverCreate({
        cwd: dir,
        failFast: true,
        providedVars: {
          SERVER_NAME: "home",
          SSH_ADDRESS: "root@192.0.2.1",
          DOMAIN: "example.com",
          CONTACT_EMAIL: "a@example.com",
        },
      })
      const env = await readEnvFile(result.envPath)
      assertEquals(env.find((e) => e.key === "TIMEZONE")?.value, "Pacific/Kiritimati")
    }))
})

// ─────────────────────────────────────────────────────────────────────
// #207 — SSH probe defaults for DOCKER_GROUP_ID / PUID / PGID.
// ─────────────────────────────────────────────────────────────────────

Deno.test("probeServer: reads docker GID + uid/gid from a successful probe", async () => {
  await withFakeSsh(OK_SSH, async () => {
    const result = await probeServer("root@192.0.2.1")
    assertEquals(result.dockerGroupId, "988")
    assertEquals(result.puid, "1000")
    assertEquals(result.pgid, "1000")
    assertEquals(result.reason, undefined)
  })
})

Deno.test("probeServer: a root SSH user keeps 1000/1000 but docker GID still comes from the server", async () => {
  await withFakeSsh(ROOT_SSH, async () => {
    const result = await probeServer("root@192.0.2.1")
    assertEquals(result.dockerGroupId, "988")
    assertEquals(result.puid, "1000")
    assertEquals(result.pgid, "1000")
  })
})

Deno.test("probeServer: docker not installed falls back to the default GID with a reason", async () => {
  await withFakeSsh(NO_DOCKER_SSH, async () => {
    const result = await probeServer("root@192.0.2.1")
    assertEquals(result.dockerGroupId, undefined)
    assertEquals(result.puid, "1000")
    assertStringIncludes(result.reason ?? "", "docker")
  })
})

Deno.test("probeServer: an SSH failure falls back to defaults with a reason", async () => {
  await withFakeSsh(FAILING_SSH, async () => {
    const result = await probeServer("root@192.0.2.1")
    assertEquals(result.dockerGroupId, undefined)
    assertEquals(result.puid, undefined)
    assertEquals(result.pgid, undefined)
    assertStringIncludes(result.reason ?? "", "192.0.2.1")
  })
})

Deno.test("server create uses the SSH probe's docker GID as the default", async () => {
  await withFakeSsh(OK_SSH, () =>
    withTmpDir(async (dir) => {
      const result = await serverCreate({
        cwd: dir,
        failFast: true,
        providedVars: {
          SERVER_NAME: "home",
          SSH_ADDRESS: "root@192.0.2.1",
          DOMAIN: "example.com",
          CONTACT_EMAIL: "a@example.com",
        },
      })
      const env = await readEnvFile(result.envPath)
      assertEquals(env.find((e) => e.key === "DOCKER_GROUP_ID")?.value, "988")
    }))
})

Deno.test("server create skips the probe entirely when all three are pre-supplied", async () => {
  // No fake ssh on PATH — this only proves the exact provided values
  // land in .env untouched; the "no probe" claim is that this test needs
  // no fake ssh script at all to stay deterministic (server-create.ts
  // only probes when at least one of the three is missing).
  await withTmpDir(async (dir) => {
    const result = await serverCreate({
      cwd: dir,
      failFast: true,
      providedVars: {
        SERVER_NAME: "home",
        SSH_ADDRESS: "root@192.0.2.1",
        DOMAIN: "example.com",
        CONTACT_EMAIL: "a@example.com",
        DOCKER_GROUP_ID: "123",
        PUID: "2000",
        PGID: "2000",
      },
    })
    const env = await readEnvFile(result.envPath)
    assertEquals(env.find((e) => e.key === "DOCKER_GROUP_ID")?.value, "123")
    assertEquals(env.find((e) => e.key === "PUID")?.value, "2000")
  })
})

// ─────────────────────────────────────────────────────────────────────
// Review fix #4 — SSH probe hardening: accept an unknown host key (the
// common case on a fresh server), separate options from the target with
// `--`, and enforce an overall deadline so a hanging ssh can't block
// the wizard.
// ─────────────────────────────────────────────────────────────────────

Deno.test("probeServer: passes BatchMode, StrictHostKeyChecking=accept-new and -- before the target", async () => {
  const argsFile = await Deno.makeTempFile({ prefix: "rostok-ssh-args-" })
  try {
    const script = `#!/bin/sh
echo "$@" > "${argsFile}"
echo "DOCKER_GID=988"
echo "SSH_UID=1000"
echo "SSH_GID=1000"
echo "SSH_USER=deploy"
`
    await withFakeSsh(script, async () => {
      await probeServer("root@192.0.2.1")
    })
    const argv = await Deno.readTextFile(argsFile)
    assertStringIncludes(argv, "BatchMode=yes")
    assertStringIncludes(argv, "StrictHostKeyChecking=accept-new")
    assertStringIncludes(argv, "-- root@192.0.2.1")
  } finally {
    await Deno.remove(argsFile).catch(() => {})
  }
})

// #218 — SSH_ADDRESS=root@192.0.2.1:2222 must reach ssh as `-p 2222
// root@192.0.2.1`, built via server-keys.ts's `sshArgs` — not as one
// unresolvable "192.0.2.1:2222" hostname.
Deno.test("probeServer: a port in SSH_ADDRESS reaches ssh as -p <port>, split from the host", async () => {
  const argsFile = await Deno.makeTempFile({ prefix: "rostok-ssh-args-" })
  try {
    const script = `#!/bin/sh
echo "$@" > "${argsFile}"
echo "DOCKER_GID=988"
echo "SSH_UID=1000"
echo "SSH_GID=1000"
echo "SSH_USER=deploy"
`
    await withFakeSsh(script, async () => {
      await probeServer("root@192.0.2.1:2222")
    })
    const argv = (await Deno.readTextFile(argsFile)).trim()
    assertStringIncludes(argv, "-p 2222")
    assertStringIncludes(argv, "-- root@192.0.2.1")
    // The port must never survive as part of the target string itself —
    // that's the #218 bug (ssh reading "192.0.2.1:2222" as one hostname).
    assertEquals(argv.includes("192.0.2.1:2222"), false, argv)
  } finally {
    await Deno.remove(argsFile).catch(() => {})
  }
})

Deno.test("probeServer: enforces the deadline and kills a hanging ssh", async () => {
  // `exec` replaces the shell with `sleep` (same PID) instead of forking
  // it — otherwise SIGKILL only reaps the shell, and the orphaned sleep
  // process keeps the piped stdout/stderr open until it exits on its
  // own, defeating the deadline entirely.
  await withFakeSsh(`#!/bin/sh\nexec sleep 5\n`, async () => {
    const start = performance.now()
    const result = await probeServer("root@192.0.2.1", { deadlineMs: 100 })
    const elapsed = performance.now() - start
    assertStringIncludes(result.reason ?? "", "timed out")
    if (elapsed > 3000) {
      throw new Error(`probeServer didn't respect the deadline: took ${elapsed}ms`)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// Security review — SSH_ADDRESS and remote paths (PATH_APPS,
// VOLUMES_PATH) reach `ssh`/`rsync` verbatim. An unvalidated
// SSH_ADDRESS starting with `-` is read as an ssh option
// (`-oProxyCommand=...` runs an arbitrary local command); an
// unvalidated remote path reaches the login shell through rsync.
// ─────────────────────────────────────────────────────────────────────

Deno.test("server create rejects an SSH_ADDRESS that looks like an ssh option", async () => {
  await withTmpDir(async (dir) => {
    await assertRejects(
      () =>
        serverCreate({
          cwd: dir,
          failFast: true,
          providedVars: {
            SERVER_NAME: "home",
            SSH_ADDRESS: "-oProxyCommand=touch /tmp/pwned",
            DOMAIN: "example.com",
            CONTACT_EMAIL: "a@example.com",
          },
        }),
      UserError,
      "invalid SSH_ADDRESS",
    )
    const entries: string[] = []
    for await (const e of Deno.readDir(dir)) entries.push(e.name)
    assertEquals(entries, [], "server create must write nothing on a rejected SSH_ADDRESS")
  })
})

Deno.test("server create rejects an SSH_ADDRESS containing a space", async () => {
  await withTmpDir(async (dir) => {
    await assertRejects(
      () =>
        serverCreate({
          cwd: dir,
          failFast: true,
          providedVars: {
            SERVER_NAME: "home",
            SSH_ADDRESS: "root@host extra",
            DOMAIN: "example.com",
            CONTACT_EMAIL: "a@example.com",
          },
        }),
      UserError,
      "invalid SSH_ADDRESS",
    )
  })
})

Deno.test("server create rejects a PATH_APPS with a command substitution", async () => {
  await withFakeSsh(OK_SSH, () =>
    withTmpDir(async (dir) => {
      await assertRejects(
        () =>
          serverCreate({
            cwd: dir,
            failFast: true,
            providedVars: {
              SERVER_NAME: "home",
              SSH_ADDRESS: "root@192.0.2.1",
              DOMAIN: "example.com",
              CONTACT_EMAIL: "a@example.com",
              PATH_APPS: "/srv/$(x)",
            },
          }),
        UserError,
        "invalid PATH_APPS",
      )
    }))
})

Deno.test("server create rejects a VOLUMES_PATH with a command substitution", async () => {
  await withFakeSsh(OK_SSH, () =>
    withTmpDir(async (dir) => {
      await assertRejects(
        () =>
          serverCreate({
            cwd: dir,
            failFast: true,
            providedVars: {
              SERVER_NAME: "home",
              SSH_ADDRESS: "root@192.0.2.1",
              DOMAIN: "example.com",
              CONTACT_EMAIL: "a@example.com",
              VOLUMES_PATH: "/srv/$(x)",
            },
          }),
        UserError,
        "invalid VOLUMES_PATH",
      )
    }))
})

// ─────────────────────────────────────────────────────────────────────
// Review fix #4 (round 4, cosmetic) — a failed probe on an existing
// server must say the saved values are kept, not "using default" (they
// aren't being defaulted, they're surviving untouched).
// ─────────────────────────────────────────────────────────────────────

Deno.test("a failed probe on an existing server says the saved values are kept, not defaulted", async () => {
  await withFakeSsh(FAILING_SSH, () =>
    withTmpDir(async (dir) => {
      await seedServerEnv(
        dir,
        "home",
        "PROJECT=hl\nSSH_ADDRESS=myhomelab\nSSH_USER=deploy\nDOMAIN=example.com\n" +
          "CONTACT_EMAIL=a@example.com\nDOCKER_GROUP_ID=977\nPUID=1500\nPGID=1500\n",
      )
      const lines: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => lines.push(args.join(" "))
      try {
        await serverCreate({ cwd: dir, failFast: true, providedVars: { SERVER_NAME: "home" } })
      } finally {
        console.log = originalLog
      }
      const probeLine = lines.find((l) => l.includes("couldn't probe"))
      assertStringIncludes(probeLine ?? "", "keeping the saved")
      assertEquals(probeLine?.includes("using default"), false, probeLine)
    }))
})

Deno.test("a failed probe on a brand-new server says the defaults are used", async () => {
  await withFakeSsh(FAILING_SSH, () =>
    withTmpDir(async (dir) => {
      const lines: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => lines.push(args.join(" "))
      try {
        await serverCreate({
          cwd: dir,
          failFast: true,
          providedVars: {
            SERVER_NAME: "home",
            SSH_ADDRESS: "myhomelab",
            DOMAIN: "example.com",
            CONTACT_EMAIL: "a@example.com",
          },
        })
      } finally {
        console.log = originalLog
      }
      const probeLine = lines.find((l) => l.includes("couldn't probe"))
      assertStringIncludes(probeLine ?? "", "using the default")
      assertEquals(probeLine?.includes("keeping the saved"), false, probeLine)
    }))
})

Deno.test("server create re-validates an SSH_ADDRESS already sitting in .env", async () => {
  // Defense in depth: a hand-edited or pre-this-fix .env shouldn't get a
  // free pass just because the bad value is "existing" rather than
  // freshly provided.
  await withTmpDir(async (dir) => {
    await seedServerEnv(
      dir,
      "home",
      "PROJECT=hl\nSSH_ADDRESS=-oProxyCommand=touch /tmp/pwned\nDOMAIN=example.com\n" +
        "CONTACT_EMAIL=a@example.com\n",
    )
    await assertRejects(
      () => serverCreate({ cwd: dir, failFast: true, providedVars: { SERVER_NAME: "home" } }),
      UserError,
      "invalid SSH_ADDRESS",
    )
  })
})
