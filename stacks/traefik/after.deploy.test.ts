// Tests for stacks/traefik/after.deploy.ts: its pure helpers, then the hook as a
// subprocess with a fake `docker` and a fake `ssh` on PATH.
//
// buildRestartCommand takes the already-parsed SSH_HOST/SSH_PORT/SSH_USER
// contract keys (#229) — parsing SSH_ADDRESS itself is cli/server-keys.ts's
// job now, exercised by cli/deploy/hooks.test.ts and cli/server-keys.test.ts.
// These tests are only about this hook's own argv shape.

import { assertEquals, assertThrows } from "@std/assert"
import { buildRestartCommand, buildTargetRestart } from "./after.deploy.ts"

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

/**
 * Runs the hook with a fake `docker` and a fake `ssh` first on PATH and returns its exit code and
 * what the fakes were called with, one call per line, each starting with the program's name. Both
 * fakes exit 0. Neither calls any program by the name `docker` or `ssh`, and a depth guard makes
 * each exit 97 if it is ever entered from itself.
 */
async function runHookWithFakes(
  hookEnv: Record<string, string>,
): Promise<{ code: number; calls: string[] }> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-traefik-" })
  const logPath = `${binDir}/calls.log`
  try {
    for (const name of ["docker", "ssh"]) {
      const script = `#!/bin/sh\n` +
        `[ -n "$FAKE_TOOL_DEPTH" ] && exit 97\n` +
        `export FAKE_TOOL_DEPTH=1\n` +
        `echo "${name} $*" >> "${logPath}"\n` +
        `exit 0\n`
      await Deno.writeTextFile(`${binDir}/${name}`, script, { mode: 0o755 })
    }
    await Deno.writeTextFile(logPath, "")
    const env = Deno.env.toObject()
    for (const key of ["SSH_ADDRESS", "SSH_HOST", "SSH_PORT", "SSH_USER", "FAKE_TOOL_DEPTH"]) {
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
  // What deploy sets for a local server: SSH_ADDRESS=local, and no SSH_HOST or SSH_PORT.
  const { code, calls } = await runHookWithFakes({ SSH_ADDRESS: "local", SSH_USER: "user" })
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
