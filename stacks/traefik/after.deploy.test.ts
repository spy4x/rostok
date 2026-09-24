// Tests for stacks/traefik/after.deploy.ts's pure helper.
// (No shell interaction — that runs via the deploy script.)
//
// buildRestartCommand takes the already-parsed SSH_HOST/SSH_PORT/SSH_USER
// contract keys (#229) — parsing SSH_ADDRESS itself is cli/server-keys.ts's
// job now, exercised by cli/deploy/hooks.test.ts and cli/server-keys.test.ts.
// These tests are only about this hook's own argv shape.

import { assertEquals } from "@std/assert"
import { buildRestartCommand } from "./after.deploy.ts"

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
