// Tests for stacks/stalwart/after.deploy.ts's pure command builders, and
// for the settings it asks for at start.
//
// buildSshArgs is the same shape as caldiy's own copy — see
// stacks/caldiy/after.deploy.test.ts for a fake-ssh subprocess proof of
// this exact argv shape reaching a real `ssh` binary.

import { assertEquals, assertThrows } from "@std/assert"
import { buildSshArgs, buildStopCommand, dkimDomains } from "./after.deploy.ts"

Deno.test("buildSshArgs: -p, the standard options, then '--' then the target and command", () => {
  const args = buildSshArgs("192.0.2.10", "22", "root", ["docker", "stop", "hl-stalwart"])
  assertEquals(args, [
    "-p",
    "22",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "--",
    "root@192.0.2.10",
    "docker",
    "stop",
    "hl-stalwart",
  ])
})

Deno.test("buildSshArgs: carries the port from SSH_ADDRESS's :2222 form (#229's reported bug)", () => {
  // Before this fix, stalwart's own inline regex rejected the
  // "host:port" form outright with "Invalid SSH_ADDRESS" — see the
  // module comment above stopStalwartAfterDkimFailure. SSH_HOST/SSH_PORT
  // are already split apart before this hook ever sees them, so there's
  // nothing left here to reject.
  const args = buildSshArgs("192.0.2.10", "2222", "root", ["docker", "stop", "hl-stalwart"])
  assertEquals(args[0], "-p")
  assertEquals(args[1], "2222")
})

Deno.test("buildSshArgs: no user — bare host as the target", () => {
  const args = buildSshArgs("homelab", "22", undefined, ["id"])
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
  const args = buildSshArgs("homelab", undefined, undefined, ["id"])
  assertEquals(args, ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "--", "homelab", "id"])
})

Deno.test("buildSshArgs: rejects a non-numeric SSH_PORT", () => {
  assertThrows(
    () => buildSshArgs("homelab", "abc", undefined, ["id"]),
    Error,
    "invalid SSH_PORT",
  )
})

Deno.test("buildSshArgs: rejects a port outside 1-65535", () => {
  assertThrows(() => buildSshArgs("homelab", "0", undefined, ["id"]), Error, "invalid SSH_PORT")
  assertThrows(
    () => buildSshArgs("homelab", "65536", undefined, ["id"]),
    Error,
    "invalid SSH_PORT",
  )
})

Deno.test("the DKIM check covers the primary domain and every STALWART_EXTRA_DOMAINS entry", () => {
  const env: Record<string, string> = {
    DOMAIN: "example.com",
    STALWART_EXTRA_DOMAINS: "example.org,example.net",
  }
  assertEquals(dkimDomains((key) => env[key]), ["example.com", "example.org", "example.net"])
  assertEquals(dkimDomains((key) => ({ DOMAIN: "example.com" } as typeof env)[key]), [
    "example.com",
  ])
})

Deno.test("buildStopCommand: no host — docker stop on this machine, no ssh", () => {
  assertEquals(buildStopCommand(undefined, undefined, "root"), {
    cmd: "docker",
    args: ["stop", "hl-stalwart"],
  })
})

Deno.test("buildStopCommand: with a host — the same stop over ssh", () => {
  assertEquals(buildStopCommand("192.0.2.10", "2222", "root"), {
    cmd: "ssh",
    args: buildSshArgs("192.0.2.10", "2222", "root", ["docker", "stop", "hl-stalwart"]),
  })
})

Deno.test("after.deploy.ts subprocess: on a local server (no SSH_HOST) it starts its work instead of asking for SSH_HOST", async () => {
  const env = Deno.env.toObject()
  for (const key of ["SSH_HOST", "SSH_PORT", "STALWART_INITIAL_DEPLOY"]) delete env[key]
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", import.meta.resolve("./after.deploy.ts")],
    env: {
      ...env,
      // What deploy sets for a local server: SSH_ADDRESS=local, and no SSH_HOST or SSH_PORT.
      SSH_ADDRESS: "local",
      SSH_USER: "root",
      STALWART_ADMIN_PASSWORD: "test-password",
      DOMAIN: "example.invalid",
    },
    clearEnv: true,
    stdout: "piped",
    stderr: "null",
  }).spawn()
  // The first line the hook prints once the settings check has passed. The health check that
  // follows needs a live mail server, so the hook is stopped there. A hook that exits at the
  // settings check prints nothing to stdout, and the read below then ends empty.
  const reader = child.stdout.getReader()
  const first = await reader.read()
  child.kill("SIGKILL")
  await reader.cancel()
  await child.status
  assertEquals(
    new TextDecoder().decode(first.value).split("\n")[0],
    "Waiting for Stalwart to become healthy...",
  )
})
