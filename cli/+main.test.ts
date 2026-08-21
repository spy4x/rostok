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

// ─────────────────────────────────────────────────────────────────────
// parseVarFlags regression tests (Phase 5)
//
// cliffy's `<kv...:string[]>` with `collect: true` produces a CIRCULAR
// structure: the last slot is a back-reference to the root array. The
// walker must detect cycles or `rostok --var A=1 --var B=2` throws
// `Maximum call stack size exceeded`. Keep these tests in sync with the
// walker in cli/+main.ts:parseVarFlags.
// ─────────────────────────────────────────────────────────────────────

// Mirror of the walker in cli/+main.ts. If you change the walker, change this too.
function parseVarFlags(flags: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!flags) return out
  const flat: string[] = []
  const seen = new WeakSet<object>()
  const walk = (v: unknown, depth: number) => {
    if (typeof v === "string") {
      flat.push(v)
      return
    }
    if (depth > 4 || v === null || typeof v !== "object") return
    if (seen.has(v as object)) return
    seen.add(v as object)
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1) }
  }
  walk(flags, 0)
  for (const f of flat) {
    const eq = f.indexOf("=")
    if (eq < 0) throw new Error(`--var requires KEY=VAL form, got: ${f}`)
    out[f.slice(0, eq)] = f.slice(eq + 1)
  }
  return out
}

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
