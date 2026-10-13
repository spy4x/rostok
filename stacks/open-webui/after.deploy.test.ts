// Tests for stacks/open-webui/after.deploy.ts's pure ssh argv helpers.
// (No shell interaction — that runs via the deploy script.)

import { assertEquals, assertThrows } from "@std/assert"
import { buildConnectScript, buildSshOptionArgs, targetHost } from "./after.deploy.ts"

Deno.test("buildSshOptionArgs: -p then the standard options", () => {
  assertEquals(buildSshOptionArgs("22"), [
    "-p",
    "22",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
  ])
})

Deno.test("buildSshOptionArgs: carries the port from SSH_ADDRESS's :2222 form (#229's reported bug)", () => {
  // Before this fix, every ssh call in this hook used the raw
  // SSH_ADDRESS string directly, so a "host:port" SSH_ADDRESS reached
  // ssh as one unresolvable hostname. SSH_HOST/SSH_PORT are already
  // split apart before this hook ever sees them.
  assertEquals(buildSshOptionArgs("2222"), [
    "-p",
    "2222",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
  ])
})

Deno.test("buildSshOptionArgs: no port — omits -p entirely (an ssh_config alias's own Port wins)", () => {
  assertEquals(buildSshOptionArgs(undefined), ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes"])
})

Deno.test("buildSshOptionArgs: rejects a non-numeric port", () => {
  assertThrows(() => buildSshOptionArgs("abc"), Error, "invalid SSH_PORT")
})

Deno.test("buildSshOptionArgs: rejects a port outside 1-65535", () => {
  assertThrows(() => buildSshOptionArgs("0"), Error, "invalid SSH_PORT")
  assertThrows(() => buildSshOptionArgs("65536"), Error, "invalid SSH_PORT")
})

Deno.test("targetHost: user@host when a user is set", () => {
  assertEquals(targetHost("192.0.2.10", "root"), "root@192.0.2.10")
})

Deno.test("targetHost: bare host with no user", () => {
  assertEquals(targetHost("homelab", undefined), "homelab")
})

/**
 * Install a fake `ssh` on PATH that appends its own argv (one per line,
 * plus a blank separator line) to `logPath`, then exits 1.
 */
async function withFakeSsh<T>(fn: (logPath: string) => Promise<T>): Promise<T> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-ssh-open-webui-" })
  const logPath = `${binDir}/argv.log`
  try {
    const script =
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${logPath}"; done\nprintf '\\n' >> "${logPath}"\nexit 1\n`
    await Deno.writeTextFile(`${binDir}/ssh`, script, { mode: 0o755 })
    const previousPath = Deno.env.get("PATH") ?? ""
    Deno.env.set("PATH", `${binDir}:${previousPath}`)
    try {
      return await fn(logPath)
    } finally {
      Deno.env.set("PATH", previousPath)
    }
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
}

Deno.test("after.deploy.ts subprocess: SSH_ADDRESS=root@192.0.2.1:2222 reaches ssh's first call as -p 2222 (fake ssh)", async () => {
  await withFakeSsh(async (logPath) => {
    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", import.meta.resolve("./after.deploy.ts")],
      env: {
        ...Deno.env.toObject(),
        // What deploy sets today, parsed once from SSH_ADDRESS=root@192.0.2.1:2222
        // by cli/deploy/hooks.ts's buildHookEnv — this hook never sees
        // SSH_ADDRESS itself any more.
        SSH_HOST: "192.0.2.1",
        SSH_PORT: "2222",
        SSH_USER: "root",
        PATH_APPS: "/srv/apps",
        OPEN_WEBUI_OPENAI_API_KEYS: "sk-test",
        OPEN_WEBUI_OPENAI_API_BASE_URLS: "https://example.com/v1",
      },
      stdout: "null",
      stderr: "null",
    })
    await command.output()
    // This test only checks what reached ssh's argv for the first call
    // (docker cp), not the rest of the hook's business logic — the fake
    // exits 1, so the hook fails right after (expected).
    const logged = await Deno.readTextFile(logPath)
    const lines = logged.split("\n")
    assertEquals(lines.slice(0, 8), [
      "-p",
      "2222",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      "--",
      "root@192.0.2.1",
    ])
  })
})

Deno.test("after.deploy.ts subprocess: no SSH_PORT — omits -p entirely (fake ssh)", async () => {
  await withFakeSsh(async (logPath) => {
    const env = { ...Deno.env.toObject() }
    delete env.SSH_PORT
    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", import.meta.resolve("./after.deploy.ts")],
      env: {
        ...env,
        SSH_HOST: "192.0.2.1",
        SSH_USER: "root",
        PATH_APPS: "/srv/apps",
        OPEN_WEBUI_OPENAI_API_KEYS: "sk-test",
        OPEN_WEBUI_OPENAI_API_BASE_URLS: "https://example.com/v1",
      },
      stdout: "null",
      stderr: "null",
    })
    await command.output()
    const logged = await Deno.readTextFile(logPath)
    const lines = logged.split("\n")
    assertEquals(lines.slice(0, 6), [
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      "--",
      "root@192.0.2.1",
    ])
  })
})

/**
 * Install a fake `ssh` on PATH that appends its own argv (one call's
 * worth of lines, then a blank separator) to `logPath`, drains any
 * stdin, and exits 0 — so the hook's full flow runs to completion and
 * every one of its ssh calls (docker cp, exec, restart) actually fires,
 * not just the first one before a failure short-circuits the rest.
 */
async function withSucceedingFakeSsh<T>(fn: (logPath: string) => Promise<T>): Promise<T> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-ssh-ok-open-webui-" })
  const logPath = `${binDir}/argv.log`
  try {
    const script = `#!/bin/sh\n` +
      `for a in "$@"; do printf '%s\\n' "$a" >> "${logPath}"; done\n` +
      `printf '\\n' >> "${logPath}"\n` +
      `cat > /dev/null\n` + // drain stdin so a piped writer never sees EPIPE
      `exit 0\n`
    await Deno.writeTextFile(`${binDir}/ssh`, script, { mode: 0o755 })
    const previousPath = Deno.env.get("PATH") ?? ""
    Deno.env.set("PATH", `${binDir}:${previousPath}`)
    try {
      return await fn(logPath)
    } finally {
      Deno.env.set("PATH", previousPath)
    }
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
}

Deno.test("after.deploy.ts subprocess: every ssh call (cp, exec, restart) puts -- before the target (review round)", async () => {
  await withSucceedingFakeSsh(async (logPath) => {
    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", import.meta.resolve("./after.deploy.ts")],
      env: {
        ...Deno.env.toObject(),
        SSH_HOST: "192.0.2.1",
        SSH_PORT: "2222",
        SSH_USER: "root",
        PATH_APPS: "/srv/apps",
        OPEN_WEBUI_OPENAI_API_KEYS: "sk-test",
        OPEN_WEBUI_OPENAI_API_BASE_URLS: "https://example.com/v1",
      },
      stdout: "piped",
      stderr: "piped",
    })
    const output = await command.output()
    if (!output.success) {
      throw new Error(
        `hook exited non-zero: ${new TextDecoder().decode(output.stderr)}`,
      )
    }

    const logged = await Deno.readTextFile(logPath)
    // Each ssh invocation logged its own argv followed by a blank line.
    const calls = logged.split("\n\n").map((block) => block.split("\n").filter((l) => l.length > 0))
      .filter((block) => block.length > 0)
    // The playwright network connection, then docker cp, docker exec, docker restart.
    assertEquals(calls.length, 4, `expected 4 ssh calls, got ${calls.length}: ${logged}`)
    assertEquals(
      calls[0].slice(8),
      buildConnectScript("hl-playwright-mcp", "hl-open-webui").split("\n"),
    )
    for (const argv of calls) {
      const dashDashIdx = argv.indexOf("--")
      assertEquals(dashDashIdx >= 0, true, `no -- found in call: ${JSON.stringify(argv)}`)
      assertEquals(argv.slice(0, dashDashIdx + 2), [
        "-p",
        "2222",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "BatchMode=yes",
        "--",
        "root@192.0.2.1",
      ])
    }
  })
})

/** What the fake `docker` answers. */
interface FakeDocker {
  /** Whether `docker network inspect` finds the network. */
  network: boolean
  /** Whether `docker inspect <container>` finds the client. */
  client: boolean
  /** The networks the client is on already, as `docker inspect -f` prints them. */
  clientNetworks: string
}

/**
 * Runs `fn` with a fake `docker` first on PATH and returns what it was called with, one call per
 * line. The fake never reaches a real Docker daemon and calls no other program by the name
 * `docker`; its depth guard makes it exit 97 if it is ever entered from itself.
 */
async function withFakeDocker(
  fake: FakeDocker,
  fn: (env: Record<string, string>) => Promise<void>,
): Promise<string[]> {
  const binDir = await Deno.makeTempDir({ prefix: `rostok-fake-docker-` })
  const logPath = `${binDir}/calls.log`
  try {
    const script = `#!/bin/sh
[ -n "$FAKE_DOCKER_DEPTH" ] && exit 97
export FAKE_DOCKER_DEPTH=1
echo "$*" >> "${logPath}"
case "$1 $2" in
  "network inspect") exit ${fake.network ? 0 : 1} ;;
  "network connect") exit 0 ;;
  "inspect -f") echo "${fake.clientNetworks}" ;;
  inspect*) exit ${fake.client ? 0 : 1} ;;
  *) exit 98 ;;
esac
`
    await Deno.writeTextFile(`${binDir}/docker`, script, { mode: 0o755 })
    await Deno.writeTextFile(logPath, ``)
    const env = Deno.env.toObject()
    for (const key of [`SSH_HOST`, `SSH_PORT`, `SSH_USER`, `FAKE_DOCKER_DEPTH`]) delete env[key]
    await fn({ ...env, PATH: `${binDir}:${env.PATH ?? ``}` })
    return (await Deno.readTextFile(logPath)).split(`\n`).filter((line) => line.length > 0)
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
}

/** Runs the hook's connect script with `sh -c`, as the hook does on a local server. */
async function runConnectScript(env: Record<string, string>): Promise<number> {
  const script = buildConnectScript(`hl-playwright-mcp`, `hl-open-webui`)
  const output = await new Deno.Command(`sh`, {
    args: [`-c`, script],
    env,
    clearEnv: true,
    stdout: `null`,
    stderr: `null`,
  }).output()
  return output.code
}

Deno.test("connect script: puts hl-open-webui on hl-playwright-mcp when that network exists (fake docker)", async () => {
  let code = -1
  const calls = await withFakeDocker(
    { network: true, client: true, clientNetworks: `proxy ` },
    async (env) => {
      code = await runConnectScript(env)
    },
  )
  assertEquals(code, 0)
  assertEquals(calls.at(-1), `network connect hl-playwright-mcp hl-open-webui`)
})

Deno.test("connect script: does nothing when the server has no hl-playwright-mcp network (fake docker)", async () => {
  let code = -1
  const calls = await withFakeDocker(
    { network: false, client: true, clientNetworks: `proxy ` },
    async (env) => {
      code = await runConnectScript(env)
    },
  )
  assertEquals(code, 0)
  assertEquals(calls, [`network inspect hl-playwright-mcp`])
})

Deno.test("connect script: does not connect a container that is on the network already (fake docker)", async () => {
  const calls = await withFakeDocker(
    { network: true, client: true, clientNetworks: `hl-playwright-mcp proxy ` },
    async (env) => {
      await runConnectScript(env)
    },
  )
  assertEquals(calls.filter((call) => call.startsWith(`network connect`)), [])
})

Deno.test("after.deploy.ts subprocess: without SSH_HOST the connection is still made, through the local docker", async () => {
  // The rest of this hook still needs SSH_HOST (spy4x/rostok#287), so it exits non-zero after.
  const calls = await withFakeDocker(
    { network: true, client: true, clientNetworks: `proxy ` },
    async (env) => {
      await new Deno.Command(Deno.execPath(), {
        args: [`run`, `-A`, import.meta.resolve(`./after.deploy.ts`)],
        env: { ...env, PATH_APPS: `/srv/apps` },
        clearEnv: true,
        stdout: `null`,
        stderr: `null`,
      }).output()
    },
  )
  assertEquals(calls.at(-1), `network connect hl-playwright-mcp hl-open-webui`)
})
