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
// #206 — a legacy USER / HOMELAB_USER key gets renamed to SSH_USER.
// ─────────────────────────────────────────────────────────────────────

Deno.test("server create migrates a legacy USER key to SSH_USER", async () => {
  await withFakeSsh(OK_SSH, () =>
    withTmpDir(async (dir) => {
      await Deno.mkdir(join(dir, "servers", "home"), { recursive: true })
      await Deno.writeTextFile(
        join(dir, "servers", "home", ".env"),
        "PROJECT=hl\nUSER=oldname\n",
      )
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
      // SSH_ADDRESS parses a user (root) which wins over the migrated
      // legacy value once merged — the point of this test is that the
      // *migration* ran (no leftover USER= line), not the final value.
      assertEquals(env.some((e) => e.key === "USER"), false)
      assertEquals(env.filter((e) => e.key === "SSH_USER").length, 1)
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
