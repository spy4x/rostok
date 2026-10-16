// Tests for stacks/caldiy/after.deploy.ts's pure command builders.
// (No shell interaction beyond the fake ssh and docker below.)

import { assertEquals, assertThrows } from "@std/assert"
import { buildPsqlCommand, buildSshArgs } from "./after.deploy.ts"

Deno.test("buildSshArgs: -p, the standard options, then '--' then the target and command", () => {
  const args = buildSshArgs("192.0.2.10", "22", "root", "docker exec -i hl-caldiy-db psql")
  assertEquals(args, [
    "-p",
    "22",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "--",
    "root@192.0.2.10",
    "docker exec -i hl-caldiy-db psql",
  ])
})

Deno.test("buildSshArgs: carries a non-default port (#229 — root cause: SSH_ADDRESS with :2222)", () => {
  const args = buildSshArgs("192.0.2.10", "2222", "root", "docker exec -i hl-caldiy-db psql")
  assertEquals(args[0], "-p")
  assertEquals(args[1], "2222")
})

Deno.test("buildSshArgs: no user — bare host as the target", () => {
  const args = buildSshArgs("homelab", "22", undefined, "id")
  assertEquals(args, [
    "-p",
    "22",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "--",
    "homelab",
    "id",
  ])
})

Deno.test("buildSshArgs: no SSH_PORT — omits -p entirely (an ssh_config alias's own Port wins)", () => {
  const args = buildSshArgs("homelab", undefined, undefined, "id")
  assertEquals(args, ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "--", "homelab", "id"])
})

Deno.test("buildSshArgs: rejects a non-numeric SSH_PORT", () => {
  assertThrows(() => buildSshArgs("homelab", "abc", undefined, "id"), Error, "invalid SSH_PORT")
})

Deno.test("buildSshArgs: rejects a port outside 1-65535", () => {
  assertThrows(() => buildSshArgs("homelab", "0", undefined, "id"), Error, "invalid SSH_PORT")
  assertThrows(() => buildSshArgs("homelab", "65536", undefined, "id"), Error, "invalid SSH_PORT")
})

/**
 * Install a fake `ssh` on PATH (beside a fake `docker`: a call to it fails the test) that appends its own argv (one per line,
 * plus a blank separator line) to `logPath`, then exits 1 — the hook's
 * own stdout/stderr pipes stay reserved for its own I/O (psql() pipes
 * the fake's stdout internally, so a real caller never sees anything
 * printed there), so the fake writes to a separate file instead.
 */
async function withFakeSsh<T>(fn: (logPath: string) => Promise<T>): Promise<T> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-ssh-caldiy-" })
  const logPath = `${binDir}/argv.log`
  try {
    const script =
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${logPath}"; done\nprintf '\\n' >> "${logPath}"\nexit 1\n`
    await Deno.writeTextFile(`${binDir}/ssh`, script, { mode: 0o755 })
    // A fake docker too: a hook that wrongly takes the local path fails here instead of reaching
    // the real Docker daemon.
    await Deno.writeTextFile(
      `${binDir}/docker`,
      `#!/bin/sh\necho "docker $*" >> "${binDir}/docker.log"\nexit 1\n`,
      { mode: 0o755 },
    )
    const previousPath = Deno.env.get("PATH") ?? ""
    Deno.env.set("PATH", `${binDir}:${previousPath}`)
    // Settled first, so a docker call is reported even when `fn` fails on the missing ssh log.
    const [outcome] = await Promise.allSettled([fn(logPath)])
    Deno.env.set("PATH", previousPath)
    const docker = await Deno.readTextFile(`${binDir}/docker.log`).catch(() => "")
    if (docker) throw new Error(`the hook ran docker on this machine, not over ssh: ${docker}`)
    if (outcome.status === "rejected") throw outcome.reason
    return outcome.value
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
}

Deno.test("after.deploy.ts subprocess: SSH_ADDRESS=root@192.0.2.1:2222 reaches ssh as -p 2222 (fake ssh)", async () => {
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
      },
      stdout: "null",
      stderr: "null",
    })
    await command.output()
    // This test only checks what reached ssh's argv, not the rest of the
    // hook's business logic — the fake exits 1, so the hook fails right
    // after (expected).
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

const PSQL = "docker exec -i hl-caldiy-db psql -U caldiy -d caldiy -t -A"

Deno.test("buildPsqlCommand: no host — docker exec on this machine, no ssh", () => {
  const { cmd, args } = buildPsqlCommand(undefined, undefined, "root")
  assertEquals([cmd, ...args].join(" "), PSQL)
})

Deno.test("buildPsqlCommand: with a host — the same psql command over ssh, as one argument", () => {
  assertEquals(buildPsqlCommand("192.0.2.1", "2222", "root"), {
    cmd: "ssh",
    args: buildSshArgs("192.0.2.1", "2222", "root", PSQL),
  })
})

/**
 * Runs the hook with a fake `docker` and a fake `ssh` first on PATH and returns its exit code and
 * what the fakes were called with, one call per line, each starting with the program's name. Both
 * fakes answer psql as a database that already holds the workflow: `1` to the connection check,
 * `7` (a workflow id) to anything else. Neither calls any program by the name `docker` or `ssh`,
 * and a depth guard makes each exit 97 if it is ever entered from itself.
 */
async function runHookWithFakes(
  hookEnv: Record<string, string>,
): Promise<{ code: number; calls: string[] }> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-caldiy-" })
  const logPath = `${binDir}/calls.log`
  try {
    for (const name of ["docker", "ssh"]) {
      const script = `#!/bin/sh\n` +
        `[ -n "$FAKE_TOOL_DEPTH" ] && exit 97\n` +
        `export FAKE_TOOL_DEPTH=1\n` +
        `echo "${name} $*" >> "${logPath}"\n` +
        `sql=$(cat)\n` +
        `case "$sql" in "SELECT 1 AS ok") echo 1 ;; *) echo 7 ;; esac\n`
      await Deno.writeTextFile(`${binDir}/${name}`, script, { mode: 0o755 })
    }
    await Deno.writeTextFile(logPath, "")
    const env = Deno.env.toObject()
    for (
      const key of [
        "SSH_ADDRESS",
        "SSH_LOCAL",
        "SSH_HOST",
        "SSH_PORT",
        "SSH_USER",
        "FAKE_TOOL_DEPTH",
      ]
    ) {
      delete env[key]
    }
    const output = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", import.meta.resolve("./after.deploy.ts")],
      env: { ...env, ...hookEnv, PATH: `${binDir}:${env.PATH ?? ""}` },
      clearEnv: true,
      stdout: "null",
      stderr: "null",
    }).output()
    const calls = (await Deno.readTextFile(logPath)).split("\n").filter((line) => line.length > 0)
    return { code: output.code, calls }
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
}

Deno.test("after.deploy.ts subprocess: on a local server (no SSH_HOST) it runs psql with the local docker and exits 0", async () => {
  // What deploy sets for a local server: SSH_ADDRESS=local, SSH_LOCAL=true, and no SSH_HOST or
  // SSH_PORT.
  const { code, calls } = await runHookWithFakes({
    SSH_ADDRESS: "local",
    SSH_LOCAL: "true",
    SSH_USER: "root",
    PATH_APPS: "/srv/apps",
  })
  // The connection check, then the lookup that finds the workflow.
  assertEquals(calls, [PSQL, PSQL])
  assertEquals(code, 0)
})

Deno.test("after.deploy.ts subprocess: with SSH_HOST it runs the same psql over ssh and exits 0", async () => {
  const { code, calls } = await runHookWithFakes({
    SSH_ADDRESS: "root@192.0.2.1:2222",
    SSH_HOST: "192.0.2.1",
    SSH_PORT: "2222",
    SSH_USER: "root",
    PATH_APPS: "/srv/apps",
  })
  const overSsh = `ssh -p 2222 -o ConnectTimeout=10 -o BatchMode=yes -- root@192.0.2.1 ${PSQL}`
  assertEquals(calls, [overSsh, overSsh])
  assertEquals(code, 0)
})

Deno.test("after.deploy.ts subprocess: without SSH_HOST and without SSH_LOCAL it refuses to run and calls no docker or ssh", async () => {
  // A hook run by hand, outside a deploy: nothing says the server is this machine.
  const { code, calls } = await runHookWithFakes({ SSH_USER: "root", PATH_APPS: "/srv/apps" })
  assertEquals(calls, [])
  assertEquals(code, 1)
})
