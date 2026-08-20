// Tests for the CLI skeleton (Phase 2).
//
// Strategy: import `buildCommand()` and assert on cliffy's metadata APIs
// (getVersion, getHelp) instead of spawning subprocesses. Fast, deterministic,
// no flag-parsing drift.

import {
  assertEquals,
  assertExists,
  assertNotStrictEquals,
  assertStringIncludes,
} from "@std/assert"
import { buildCommand } from "./+main.ts"
import { DESCRIPTION, NAME, VERSION } from "./version.ts"

Deno.test("buildCommand: returns a fresh Command on every call", () => {
  // Important for tests — sharing one Command across cases would mutate state.
  const a = buildCommand()
  const b = buildCommand()
  assertNotStrictEquals(a, b)
})

Deno.test("buildCommand: name and description match version.ts", () => {
  const cmd = buildCommand()
  assertEquals(cmd.getName(), NAME)
  assertEquals(cmd.getDescription(), DESCRIPTION)
})

Deno.test("--version: prints the package name + version", () => {
  const cmd = buildCommand()
  const out = cmd.getVersion()
  assertExists(out)
  // Cliffy prints just the version string when --version is the only flag.
  // The full banner with the binary name comes from getLongVersion().
  assertStringIncludes(out, VERSION)
  const banner = cmd.getLongVersion()
  assertStringIncludes(banner, NAME)
  assertStringIncludes(banner, VERSION)
})

Deno.test("--help: lists subcommands server/stack/deploy", () => {
  const cmd = buildCommand()
  const help = cmd.getHelp()
  assertStringIncludes(help, "server")
  assertStringIncludes(help, "stack")
  assertStringIncludes(help, "deploy")
  assertStringIncludes(help, NAME)
})

Deno.test("--help: nested subcommands are registered with descriptions", () => {
  const cmd = buildCommand()
  const serverCmd = cmd.getCommand("server")
  assertExists(serverCmd)
  // Robust to wording tweaks — only assert the stable phrase.
  assertStringIncludes(serverCmd.getDescription(), "Manage rostok servers")
  assertEquals(serverCmd.hasCommand("create"), true)

  const stackCmd = cmd.getCommand("stack")
  assertExists(stackCmd)
  assertEquals(stackCmd.hasCommand("add"), true)
  assertEquals(stackCmd.hasCommand("list"), true)

  const deployCmd = cmd.getCommand("deploy")
  assertExists(deployCmd)
  assertStringIncludes(deployCmd.getDescription(), "Deploy a server")
})
