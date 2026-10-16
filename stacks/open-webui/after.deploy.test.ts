// Tests for stacks/open-webui/after.deploy.ts: its pure command helpers, then the hook as a
// subprocess with a fake `ssh` or a fake `docker` on PATH.

import { assertEquals, assertThrows } from "@std/assert"
import {
  buildConnectScript,
  buildSshOptionArgs,
  buildTargetCommand,
  MCP_NETWORKS,
  targetHost,
} from "./after.deploy.ts"

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
    // One network connection per MCP stack, then docker cp, docker exec, docker restart.
    assertEquals(calls.length, 7, `expected 7 ssh calls, got ${calls.length}: ${logged}`)
    assertEquals(
      calls.slice(0, 4).map((argv) => argv.slice(8).join("\n")),
      MCP_NETWORKS.map((network) => buildConnectScript(network, "hl-open-webui")),
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

Deno.test("after.deploy.ts subprocess: without SSH_HOST it connects hl-open-webui to every MCP stack's network, through the local docker", async () => {
  // No provider settings are passed, so the hook exits non-zero after the connections.
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
  assertEquals(
    calls.filter((call) => call.startsWith(`network connect`)),
    [
      `network connect hl-playwright-mcp hl-open-webui`,
      `network connect hl-email-mcp hl-open-webui`,
      `network connect hl-github-mcp hl-open-webui`,
      `network connect hl-google-maps-mcp hl-open-webui`,
    ],
  )
})

Deno.test("buildTargetCommand: no host — the command itself, for this machine, with no shell", () => {
  const argv = ["docker", "cp", "/srv/my apps/init-models.py", "hl-open-webui:/tmp/init-models.py"]
  assertEquals(buildTargetCommand(argv, undefined, undefined, "root"), argv)
})

Deno.test("buildTargetCommand: with a host — ssh, with the command as one argument for the server's shell", () => {
  assertEquals(
    buildTargetCommand(["docker", "restart", "hl-open-webui"], "192.0.2.1", "2222", "root"),
    [
      "ssh",
      "-p",
      "2222",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      "--",
      "root@192.0.2.1",
      "docker restart hl-open-webui",
    ],
  )
})

Deno.test("buildTargetCommand: over ssh an argument with shell syntax reaches the server's shell quoted", async () => {
  const hostile = "/srv/a b/$(echo x)/it's;id"
  const command = buildTargetCommand(["printf", "%s", hostile], "homelab", undefined, undefined)
  // What sshd does with the command: hand it to the user's shell.
  const output = await new Deno.Command("sh", { args: ["-c", command.at(-1)!] }).output()
  assertEquals(new TextDecoder().decode(output.stdout), hostile)
})

/**
 * Runs the whole hook with a fake `docker` and a fake `ssh` first on PATH. Returns its exit code,
 * what the fakes were called with (one call per line, each starting with the program's name, a
 * newline inside an argument shown as `;`) and
 * what the hook wrote to their stdin. Both fakes exit 0, except that `docker network inspect`
 * exits 1: a server without the playwright stack. Neither calls any program by the name `docker`
 * or `ssh`, and a depth guard makes each exit 97 if it is ever entered from itself.
 */
async function runHookWithFakes(
  hookEnv: Record<string, string>,
): Promise<{ code: number; calls: string[]; stdin: string }> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-open-webui-" })
  const logPath = `${binDir}/calls.log`
  const stdinPath = `${binDir}/stdin.log`
  try {
    for (const name of ["docker", "ssh"]) {
      const script = `#!/bin/sh\n` +
        `[ -n "$FAKE_TOOL_DEPTH" ] && exit 97\n` +
        `export FAKE_TOOL_DEPTH=1\n` +
        `printf "%s" "${name} $*" | tr "\\n" ";" >> "${logPath}"\n` +
        `echo >> "${logPath}"\n` +
        `cat >> "${stdinPath}"\n` +
        `[ "${name} $1 $2" = "docker network inspect" ] && exit 1\n` +
        `exit 0\n`
      await Deno.writeTextFile(`${binDir}/${name}`, script, { mode: 0o755 })
    }
    await Deno.writeTextFile(logPath, "")
    await Deno.writeTextFile(stdinPath, "")
    const env = Deno.env.toObject()
    for (const key of ["SSH_ADDRESS", "SSH_HOST", "SSH_PORT", "SSH_USER", "FAKE_TOOL_DEPTH"]) {
      delete env[key]
    }
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", import.meta.resolve("./after.deploy.ts")],
      env: {
        ...env,
        PATH_APPS: "/srv/apps",
        OPEN_WEBUI_OPENAI_API_KEYS: "sk-test",
        OPEN_WEBUI_OPENAI_API_BASE_URLS: "https://example.com/v1",
        ...hookEnv,
        PATH: `${binDir}:${env.PATH ?? ""}`,
      },
      clearEnv: true,
      stdout: "null",
      stderr: "null",
    }).output()
    const calls = (await Deno.readTextFile(logPath)).split("\n").filter((line) => line.length > 0)
    return { code: output.code, calls, stdin: await Deno.readTextFile(stdinPath) }
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
}

/** The script the hook runs inside the container; it reads the two settings from stdin. */
const CONTAINER_SCRIPT = `IFS= read -r k; IFS= read -r u; ` +
  `export OPENAI_API_KEYS="$k" OPENAI_API_BASE_URLS="$u"; exec python3 /tmp/init-models.py`

Deno.test("after.deploy.ts subprocess: on a local server (no SSH_HOST) it copies, runs and restarts with the local docker and exits 0", async () => {
  // What deploy sets for a local server: SSH_ADDRESS=local, and no SSH_HOST or SSH_PORT.
  const { code, calls, stdin } = await runHookWithFakes({ SSH_ADDRESS: "local", SSH_USER: "root" })
  assertEquals(calls, [
    "docker network inspect hl-playwright-mcp",
    "docker network inspect hl-email-mcp",
    "docker network inspect hl-github-mcp",
    "docker network inspect hl-google-maps-mcp",
    "docker cp /srv/apps/stacks/open-webui/init-models.py hl-open-webui:/tmp/init-models.py",
    `docker exec -i hl-open-webui sh -c ${CONTAINER_SCRIPT}`,
    "docker restart hl-open-webui",
  ])
  assertEquals(stdin, "sk-test\nhttps://example.com/v1\n")
  assertEquals(code, 0)
})

Deno.test("after.deploy.ts subprocess: with SSH_HOST it copies, runs and restarts over ssh and exits 0", async () => {
  const { code, calls, stdin } = await runHookWithFakes({
    SSH_ADDRESS: "root@192.0.2.1:2222",
    SSH_HOST: "192.0.2.1",
    SSH_PORT: "2222",
    SSH_USER: "root",
  })
  const ssh = "ssh -p 2222 -o ConnectTimeout=10 -o BatchMode=yes -- root@192.0.2.1"
  assertEquals(calls.slice(4), [
    `${ssh} docker cp /srv/apps/stacks/open-webui/init-models.py hl-open-webui:/tmp/init-models.py`,
    `${ssh} docker exec -i hl-open-webui sh -c '${CONTAINER_SCRIPT}'`,
    `${ssh} docker restart hl-open-webui`,
  ])
  // The first four calls are the connect scripts, which an earlier test covers.
  assertEquals(calls.length, 7)
  assertEquals(stdin, "sk-test\nhttps://example.com/v1\n")
  assertEquals(code, 0)
})
