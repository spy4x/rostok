// Tests for stacks/stalwart/after.deploy.ts's pure ssh argv builder.
// (No shell interaction — that runs via the deploy script.)
//
// buildSshArgs is the same shape as caldiy's own copy — see
// stacks/caldiy/after.deploy.test.ts for a fake-ssh subprocess proof of
// this exact argv shape reaching a real `ssh` binary.

import { assertEquals } from "@std/assert"
import { buildSshArgs } from "./after.deploy.ts"

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
