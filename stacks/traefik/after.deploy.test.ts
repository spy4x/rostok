// Tests for stacks/traefik/after.deploy.ts: its pure helpers, then the hook as a
// subprocess with a fake `docker` and a fake `ssh` on PATH.
//
// buildRestartCommand takes the already-parsed SSH_HOST/SSH_PORT/SSH_USER
// contract keys (#229) — parsing SSH_ADDRESS itself is cli/server-keys.ts's
// job now, exercised by cli/deploy/hooks.test.ts and cli/server-keys.test.ts.
// These tests are only about this hook's own argv shape.

import { assertEquals, assertThrows } from "@std/assert"
import {
  buildRestartCommand,
  buildTargetRestart,
  buildTargetShell,
  needsRestart,
} from "./after.deploy.ts"

Deno.test("buildRestartCommand: -p, the standard options, then '--' then the target", () => {
  const args = buildRestartCommand("192.0.2.10", "22", "user", "hl-traefik")
  assertEquals(args, [
    "-p",
    "22",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "--",
    "user@192.0.2.10",
    "docker",
    "restart",
    "hl-traefik",
  ])
})

Deno.test("buildRestartCommand: carries a non-default port", () => {
  const args = buildRestartCommand("192.0.2.10", "2222", "user", "hl-traefik")
  assertEquals(args, [
    "-p",
    "2222",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "--",
    "user@192.0.2.10",
    "docker",
    "restart",
    "hl-traefik",
  ])
})

Deno.test("buildRestartCommand: no user — bare host as the target", () => {
  const args = buildRestartCommand("homelab", "22", undefined, "hl-traefik")
  assertEquals(args, [
    "-p",
    "22",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "--",
    "homelab",
    "docker",
    "restart",
    "hl-traefik",
  ])
})

Deno.test("buildRestartCommand: a bare IPv6 host is never bracketed here", () => {
  // ssh gets the host and -p <port> as separate argv slots, so the
  // brackets that would disambiguate a combined "host:port" string
  // aren't needed (or added) — see targetHost's comment in server-keys.ts.
  const args = buildRestartCommand("2001:db8::1", "2222", undefined, "hl-traefik")
  assertEquals(args, [
    "-p",
    "2222",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "--",
    "2001:db8::1",
    "docker",
    "restart",
    "hl-traefik",
  ])
})

Deno.test("buildRestartCommand: no SSH_PORT — omits -p entirely (an ssh_config alias's own Port wins)", () => {
  const args = buildRestartCommand("homelab", undefined, undefined, "hl-traefik")
  assertEquals(args, [
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "--",
    "homelab",
    "docker",
    "restart",
    "hl-traefik",
  ])
})

Deno.test("buildRestartCommand: rejects a non-numeric SSH_PORT", () => {
  assertThrows(
    () => buildRestartCommand("192.0.2.10", "abc", "user", "hl-traefik"),
    Error,
    "invalid SSH_PORT",
  )
})

Deno.test("buildRestartCommand: rejects a port outside 1-65535", () => {
  assertThrows(
    () => buildRestartCommand("192.0.2.10", "0", "user", "hl-traefik"),
    Error,
    "invalid SSH_PORT",
  )
  assertThrows(
    () => buildRestartCommand("192.0.2.10", "65536", "user", "hl-traefik"),
    Error,
    "invalid SSH_PORT",
  )
})

Deno.test("buildTargetRestart: no host — docker restart on this machine, no ssh", () => {
  assertEquals(buildTargetRestart(undefined, undefined, "user", "hl-traefik"), {
    cmd: "docker",
    args: ["restart", "hl-traefik"],
  })
})

Deno.test("buildTargetRestart: with a host — the same restart over ssh", () => {
  assertEquals(buildTargetRestart("192.0.2.10", "2222", "user", "hl-traefik"), {
    cmd: "ssh",
    args: buildRestartCommand("192.0.2.10", "2222", "user", "hl-traefik"),
  })
})

// ── restart only on a change (#397) ─────────────────────────────────────

Deno.test("needsRestart: a file older than the container's start keeps it running", () => {
  assertEquals(needsRestart("ctime=1700000000\nstarted=2023-11-14T22:14:00.123456789Z\n"), false)
})

Deno.test("needsRestart: a file changed after the container started restarts it", () => {
  assertEquals(needsRestart("ctime=1700000100\nstarted=2023-11-14T22:14:00.123456789Z\n"), true)
})

Deno.test("needsRestart: a file changed in the second the container started restarts it", () => {
  assertEquals(needsRestart("ctime=1699999999\nstarted=2023-11-14T22:13:19.999Z\n"), true)
})

Deno.test("needsRestart: a missing file, container or start time restarts it", () => {
  assertEquals(needsRestart("ctime=\nstarted=2023-11-14T22:14:00Z\n"), true)
  assertEquals(needsRestart("ctime=1700000000\nstarted=\n"), true)
  assertEquals(needsRestart("ctime=1700000000\nstarted=0001-01-01T00:00:00Z\n"), true)
  assertEquals(needsRestart(""), true)
})

Deno.test("buildTargetShell: no host — sh -c on this machine; with a host — the script over ssh", () => {
  assertEquals(buildTargetShell(undefined, undefined, "user", "echo hi"), {
    cmd: "sh",
    args: ["-c", "echo hi"],
  })
  assertEquals(buildTargetShell("192.0.2.10", undefined, "user", "echo hi"), {
    cmd: "ssh",
    args: ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "--", "user@192.0.2.10", "echo hi"],
  })
})

/**
 * Runs the hook with a fake `docker` and a fake `ssh` first on PATH and returns its exit code and
 * what the fakes were called with, one call per line, each starting with the program's name. Both
 * fakes exit 0. `docker inspect` prints `FAKE_STARTED` when the env sets it, and `ssh` runs its
 * last argument with `sh -c` when `FAKE_SSH_RUN` is set, as a server would. Neither calls any
 * program by the name `docker` or `ssh`, and a depth guard per fake makes each exit 97 if it is
 * ever entered from itself.
 */
async function runHookWithFakes(
  hookEnv: Record<string, string>,
): Promise<{ code: number; calls: string[] }> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-traefik-" })
  const logPath = `${binDir}/calls.log`
  try {
    for (const name of ["docker", "ssh"]) {
      const depth = `FAKE_${name.toUpperCase()}_DEPTH`
      const script = `#!/bin/sh\n` +
        `[ -n "$${depth}" ] && exit 97\n` +
        `export ${depth}=1\n` +
        `echo "${name} $*" >> "${logPath}"\n` +
        `[ "$1" = inspect ] && [ -n "$FAKE_STARTED" ] && echo "$FAKE_STARTED"\n` +
        `if [ -n "$FAKE_SSH_RUN" ]; then for a; do last=$a; done; sh -c "$last"; fi\n` +
        `exit 0\n`
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
        "PATH_APPS",
        "FAKE_DOCKER_DEPTH",
        "FAKE_SSH_DEPTH",
        "FAKE_STARTED",
        "FAKE_SSH_RUN",
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

Deno.test("after.deploy.ts subprocess: on a local server (no SSH_HOST) it restarts hl-traefik with the local docker and exits 0", async () => {
  // What deploy sets for a local server: SSH_ADDRESS=local, SSH_LOCAL=true, and no SSH_HOST or
  // SSH_PORT.
  const { code, calls } = await runHookWithFakes({
    SSH_ADDRESS: "local",
    SSH_LOCAL: "true",
    SSH_USER: "user",
  })
  assertEquals(calls, ["docker restart hl-traefik"])
  assertEquals(code, 0)
})

Deno.test("after.deploy.ts subprocess: with SSH_HOST it restarts hl-traefik over ssh and exits 0", async () => {
  const { code, calls } = await runHookWithFakes({
    SSH_ADDRESS: "user@192.0.2.10:2222",
    SSH_HOST: "192.0.2.10",
    SSH_PORT: "2222",
    SSH_USER: "user",
  })
  assertEquals(calls, [
    "ssh -p 2222 -o ConnectTimeout=10 -o BatchMode=yes -- user@192.0.2.10 docker restart hl-traefik",
  ])
  assertEquals(code, 0)
})

Deno.test("after.deploy.ts subprocess: without SSH_HOST and without SSH_LOCAL it refuses to run and calls no docker or ssh", async () => {
  // A hook run by hand, outside a deploy: nothing says the server is this machine.
  const { code, calls } = await runHookWithFakes({ SSH_USER: "user" })
  assertEquals(calls, [])
  assertEquals(code, 1)
})

/** A server folder (PATH_APPS) holding the file hl-traefik's restart depends on. */
async function makeServer(): Promise<string> {
  const pathApps = await Deno.makeTempDir({ prefix: "rostok-server-traefik-" })
  await Deno.mkdir(`${pathApps}/stacks/traefik/dynamic`, { recursive: true })
  await Deno.writeTextFile(`${pathApps}/stacks/traefik/dynamic/.htpasswd`, "deployed\n")
  return pathApps
}

Deno.test("an unchanged file on a local server leaves hl-traefik running", async () => {
  const pathApps = await makeServer()
  try {
    const { code, calls } = await runHookWithFakes({
      SSH_ADDRESS: "local",
      SSH_LOCAL: "true",
      PATH_APPS: pathApps,
      FAKE_STARTED: "2999-01-01T00:00:00.5Z",
    })
    assertEquals(calls, ["docker inspect -f {{.State.StartedAt}} hl-traefik"])
    assertEquals(code, 0)
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("a file changed after hl-traefik started restarts it on a local server", async () => {
  const pathApps = await makeServer()
  try {
    const { code, calls } = await runHookWithFakes({
      SSH_ADDRESS: "local",
      SSH_LOCAL: "true",
      PATH_APPS: pathApps,
      FAKE_STARTED: "2000-01-01T00:00:00Z",
    })
    assertEquals(calls, [
      "docker inspect -f {{.State.StartedAt}} hl-traefik",
      "docker restart hl-traefik",
    ])
    assertEquals(code, 0)
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("a missing file restarts hl-traefik on a local server", async () => {
  const pathApps = await Deno.makeTempDir({ prefix: "rostok-server-traefik-" })
  try {
    const { calls } = await runHookWithFakes({
      SSH_ADDRESS: "local",
      SSH_LOCAL: "true",
      PATH_APPS: pathApps,
      FAKE_STARTED: "2999-01-01T00:00:00Z",
    })
    assertEquals(calls.at(-1), "docker restart hl-traefik")
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("over ssh, an unchanged file leaves hl-traefik running and a changed one restarts it", async () => {
  const pathApps = await makeServer()
  const sshEnv = {
    SSH_ADDRESS: "user@192.0.2.10",
    SSH_HOST: "192.0.2.10",
    SSH_USER: "user",
    PATH_APPS: pathApps,
    FAKE_SSH_RUN: "1",
  }
  try {
    const kept = await runHookWithFakes({ ...sshEnv, FAKE_STARTED: "2999-01-01T00:00:00Z" })
    assertEquals(kept.calls.filter((c) => c.includes("restart")), [])
    assertEquals(kept.code, 0)
    const changed = await runHookWithFakes({ ...sshEnv, FAKE_STARTED: "2000-01-01T00:00:00Z" })
    assertEquals(
      changed.calls.at(-1),
      "ssh -o ConnectTimeout=10 -o BatchMode=yes -- user@192.0.2.10 docker restart hl-traefik",
    )
    assertEquals(changed.code, 0)
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})
