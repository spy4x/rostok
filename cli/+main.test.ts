// Tests for cli/+main.ts.
//
// Phase 2 skeleton tests verify buildCommand metadata. Phase 5 adds
// parseVarFlags regression coverage (circular-input handling).

import {
  assertEquals,
  assertExists,
  assertNotStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert"
import { Command } from "@cliffy/command"
import { buildCommand, parseStackFlags, parseVarFlags } from "./+main.ts"
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
  // Phase 9: description now embeds examples under the original tagline.
  // Check the tagline is preserved at the top.
  const desc = cmd.getDescription()
  assertEquals(typeof desc === "string" && desc.startsWith(DESCRIPTION), true)
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

Deno.test("--help: lists subcommands server/stack/deploy/env", () => {
  const cmd = buildCommand()
  const help = cmd.getHelp()
  assertStringIncludes(help, "server")
  assertStringIncludes(help, "stack")
  assertStringIncludes(help, "deploy")
  assertStringIncludes(help, "env")
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

  // Phase 6: stack list now has real --format / --tree flags. Stable
  // assertions — wording in descriptions may shift.
  const listCmd = stackCmd.getCommand("list")
  assertExists(listCmd)
  assertStringIncludes(listCmd.getDescription().toLowerCase(), "catalog")

  const deployCmd = cmd.getCommand("deploy")
  assertExists(deployCmd)
  assertStringIncludes(deployCmd.getDescription(), "Deploy a server")

  const envCmd = cmd.getCommand("env")
  assertExists(envCmd)
  // Robust — only assert the stable phrase "encryption".
  assertStringIncludes(envCmd.getDescription().toLowerCase(), "encryption")
  assertEquals(envCmd.hasCommand("encrypt"), true)
  assertEquals(envCmd.hasCommand("decrypt"), true)
  assertEquals(envCmd.hasCommand("status"), true)
  assertEquals(envCmd.hasCommand("setup"), true)
})

// ─────────────────────────────────────────────────────────────────────
// parseVarFlags / parseStackFlags regression tests (Phase 5)
//
// cliffy's `<kv...:string[]>` with `collect: true` produces a CIRCULAR
// structure: the last slot is a back-reference to the root array. The
// shared walker (flattenCliffyCollect in cli/+main.ts) must detect
// cycles or `rostok --var A=1 --var B=2` throws "Maximum call stack
// size exceeded". Both flag parsers are exported so these tests exercise
// the real implementation, not a mirror.
// ─────────────────────────────────────────────────────────────────────

Deno.test("parseVarFlags: single --var → one entry", async () => {
  let captured: Record<string, string> = {}
  const cmd = new Command()
    .option("--var <kv...:string[]>", "repeatable", { collect: true })
    .action((options) => {
      captured = parseVarFlags(options.var)
    })
    .throwErrors()
  await cmd.parse(["--var", "A=1"])
  assertEquals(captured, { A: "1" })
})

Deno.test("parseVarFlags: multiple --var flags don't infinite-loop on circular cliffy output", async () => {
  let captured: Record<string, string> = {}
  const cmd = new Command()
    .option("--var <kv...:string[]>", "repeatable", { collect: true })
    .action((options) => {
      captured = parseVarFlags(options.var)
    })
    .throwErrors()
  // Regression: this used to throw "Maximum call stack size exceeded"
  // because cliffy's collect output is circular and the walker recursed
  // without cycle detection.
  await cmd.parse(["--var", "A=1", "--var", "B=2", "--var", "C=3"])
  assertEquals(captured, { A: "1", B: "2", C: "3" })
})

Deno.test("parseVarFlags: rejects --var without KEY=VAL form", () => {
  assertThrows(
    () => parseVarFlags(["BARE_NO_EQUALS"]),
    Error,
    "--var requires KEY=VAL",
  )
})

Deno.test("parseVarFlags: undefined input returns empty record", () => {
  assertEquals(parseVarFlags(undefined), {})
})

Deno.test("parseStackFlags: multiple --stack flags don't infinite-loop on circular cliffy output", async () => {
  let captured: string[] = []
  const cmd = new Command()
    .option("--stack <name...:string[]>", "repeatable", { collect: true })
    .action((options) => {
      captured = parseStackFlags(options.stack)
    })
    .throwErrors()
  await cmd.parse(["--stack", "traefik", "--stack", "gatus"])
  assertEquals(captured, ["traefik", "gatus"])
})

Deno.test("parseStackFlags: undefined input returns empty array", () => {
  assertEquals(parseStackFlags(undefined), [])
})

// ─────────────────────────────────────────────────────────────────────
// #209 — --help documents the server --var keys (env-style + aliases).
// ─────────────────────────────────────────────────────────────────────

Deno.test("--help: root command lists server --var keys", () => {
  const cmd = buildCommand()
  const help = cmd.getHelp()
  assertStringIncludes(help, "SSH_ADDRESS")
  assertStringIncludes(help, "CONTACT_EMAIL")
  assertStringIncludes(help, "legacy aliases")
  assertStringIncludes(help, "sshTarget")
})

Deno.test("--help: server create lists its --var option", () => {
  const cmd = buildCommand()
  const createCmd = cmd.getCommand("server")!.getCommand("create")
  assertExists(createCmd)
  assertEquals(createCmd.hasOption("var"), true)
  assertStringIncludes(createCmd.getDescription(), "SSH_ADDRESS")
})
