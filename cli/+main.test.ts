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
import { join } from "@std/path"
import { buildCommand, formatCliError, parseStackFlags, parseVarFlags } from "./+main.ts"
import { DESCRIPTION, NAME, VERSION } from "./version.ts"
import { readEnvFile } from "./env-files.ts"
import { UserError } from "./errors.ts"
import { loadCatalog } from "./catalog.ts"

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

// ─────────────────────────────────────────────────────────────────────
// Review fix #5 — a real wiring test for `rostok server create --var`:
// drive it through buildCommand().parse(), the same entry point the
// binary uses, instead of only calling serverCreate() directly. Removing
// the --var registration or the option→providedVars wiring in +main.ts
// would leave this red.
// ─────────────────────────────────────────────────────────────────────

/** Write a fake `ssh` on its own PATH entry, prepended for the duration of `fn`. */
async function withFakeSsh<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-fakessh-" })
  const scriptPath = join(dir, "ssh")
  await Deno.writeTextFile(
    scriptPath,
    `#!/bin/sh
echo "DOCKER_GID=988"
echo "SSH_UID=1000"
echo "SSH_GID=1000"
echo "SSH_USER=deploy"
`,
  )
  await Deno.chmod(scriptPath, 0o755)
  const oldPath = Deno.env.get("PATH") ?? ""
  Deno.env.set("PATH", `${dir}${Deno.build.os === "windows" ? ";" : ":"}${oldPath}`)
  try {
    return await fn()
  } finally {
    Deno.env.set("PATH", oldPath)
    await Deno.remove(dir, { recursive: true })
  }
}

Deno.test("wiring: `server create --var` reaches serverCreate through buildCommand().parse()", async () => {
  await withFakeSsh(async () => {
    const tmp = await Deno.makeTempDir({ prefix: "rostok-main-server-create-" })
    const originalCwd = Deno.cwd()
    try {
      Deno.chdir(tmp)
      await buildCommand().parse([
        "server",
        "create",
        "home",
        "-n",
        "--var",
        "SSH_ADDRESS=root@192.0.2.1",
        "--var",
        "DOMAIN=example.com",
        "--var",
        "CONTACT_EMAIL=a@example.com",
      ])
      const env = await readEnvFile(join(tmp, "servers", "home", ".env"))
      assertEquals(env.find((e) => e.key === "DOMAIN")?.value, "example.com")
      assertEquals(env.find((e) => e.key === "SSH_USER")?.value, "root")
    } finally {
      Deno.chdir(originalCwd)
      await Deno.remove(tmp, { recursive: true }).catch(() => {})
    }
  })
})

// #212 — `rostok stack add` prints "Next steps" (files written, what to
// run next, DNS records) through the real buildCommand().parse() entry
// point, not just from calling stackAdd() directly.
Deno.test("wiring: `stack add` through buildCommand().parse() prints next steps + DNS records", async () => {
  await withFakeSsh(async () => {
    const tmp = await Deno.makeTempDir({ prefix: "rostok-main-stack-add-" })
    const originalCwd = Deno.cwd()
    const originalLog = console.log
    const printed: string[] = []
    console.log = (...args: unknown[]) => {
      printed.push(args.map(String).join(" "))
    }
    try {
      Deno.chdir(tmp)
      await buildCommand().parse([
        "server",
        "create",
        "home",
        "-n",
        "--var",
        "SSH_ADDRESS=root@203.0.113.9",
        "--var",
        "DOMAIN=example.com",
        "--var",
        "CONTACT_EMAIL=a@example.com",
      ])
      // librespeed requires traefik — non-interactive mode adds it
      // automatically, so this also exercises #212 point 1 end to end.
      await buildCommand().parse(["stack", "add", "librespeed", "-s", "home", "-n"])
    } finally {
      console.log = originalLog
      Deno.chdir(originalCwd)
      await Deno.remove(tmp, { recursive: true }).catch(() => {})
    }
    const output = printed.join("\n")
    assertStringIncludes(output, "Wrote:")
    assertStringIncludes(output, join("servers", "home", ".env"))
    assertStringIncludes(output, "rostok deploy home")
    assertStringIncludes(output, "DNS records:")
    assertStringIncludes(output, "A example.com → 203.0.113.9")
    assertStringIncludes(output, "A *.example.com → 203.0.113.9")
  })
})

// ─────────────────────────────────────────────────────────────────────
// #211 — user errors print without a stack trace.
//
// `formatCliError` is tested directly for the exact line shapes,
// including the ROSTOK_DEBUG branch (no subprocess or Deno.exit needed).
// The three CLI-argument scenarios from the issue run as real
// subprocesses (`deno run -A cli/+main.ts …`), the same entry point a
// user invokes, so a regression in the `.throwErrors()` wiring or the
// `if (import.meta.main)` guard would be caught, not just a regression
// in `formatCliError` itself.
// ─────────────────────────────────────────────────────────────────────

Deno.test("formatCliError: UserError prints one line, no trace", () => {
  const lines = formatCliError(new UserError("bad input"), false)
  assertEquals(lines, ["rostok: bad input"])
})

Deno.test("formatCliError: unexpected error prints message + bug pointer, no trace by default", () => {
  const lines = formatCliError(new Error("boom"), false)
  assertEquals(lines, [
    "rostok: unexpected error: boom",
    "this is a bug, please report it at https://github.com/spy4x/rostok/issues",
  ])
})

Deno.test("formatCliError: ROSTOK_DEBUG (passed as debug=true) appends the stack trace", () => {
  const err = new Error("boom")
  const lines = formatCliError(err, true)
  assertEquals(lines.length, 3)
  assertStringIncludes(lines[2], "boom")
  // A real stack trace has at least one "    at " frame line.
  assertStringIncludes(lines[2], "at ")
})

Deno.test("formatCliError: debug=false never appends a trace even if one exists", () => {
  const err = new Error("boom")
  const lines = formatCliError(err, false)
  assertEquals(lines.length, 2)
})

const MAIN_TS = join(import.meta.dirname!, "+main.ts")

/** Run `deno run -A cli/+main.ts <args>` as a real subprocess against an existing cwd. */
async function runMainIn(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN_TS, ...args],
    cwd,
    env,
    stdout: "piped",
    stderr: "piped",
  })
  const out = await cmd.output()
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  }
}

/** Run `deno run -A cli/+main.ts <args>` as a real subprocess, in a fresh temp cwd. */
async function runMainSubprocess(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-main-subprocess-" })
  try {
    return await runMainIn(tmp, args, env)
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {})
  }
}

/** No line in `text` starts with the `    at ` prefix a Deno stack trace frame uses. */
function assertNoStackFrame(text: string) {
  for (const line of text.split("\n")) {
    if (line.startsWith("    at ")) {
      throw new Error(`expected no stack trace frame, got line: ${JSON.stringify(line)}`)
    }
  }
}

Deno.test({
  name: "subprocess: `stack add nope -s a -n` fails as rostok: <message>, no trace",
  async fn() {
    // Review fix — server "a" must exist first, or this hits "server not
    // found" instead of ever reaching the catalog lookup the issue's
    // example is actually about.
    const tmp = await Deno.makeTempDir({ prefix: "rostok-main-subprocess-" })
    try {
      const create = await runMainIn(tmp, [
        "server",
        "create",
        "a",
        "-n",
        "--var",
        "SSH_ADDRESS=root@203.0.113.9",
        "--var",
        "DOMAIN=example.com",
        "--var",
        "CONTACT_EMAIL=a@example.com",
      ])
      assertEquals(create.code, 0, create.stderr)

      const result = await runMainIn(tmp, ["stack", "add", "nope", "-s", "a", "-n"])
      assertEquals(result.code, 1)
      // Review fix — the exact line, not a substring: a substring check
      // would also pass if `catalog.ts`'s message text drifted (e.g.
      // dropped the "available:" list) as long as "not found in
      // catalog" still appeared somewhere.
      const available = loadCatalog().map((e) => e.name).join(", ")
      assertEquals(
        result.stderr.trim(),
        `rostok: stack 'nope' not found in catalog. available: ${available}`,
      )
      assertNoStackFrame(result.stderr)
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => {})
    }
  },
})

Deno.test({
  name: "subprocess: -n run with a required value missing fails as rostok: <message>, no trace",
  async fn() {
    // Non-interactive server create with no --var at all: SSH_ADDRESS
    // has no default, so this hits the "missing <key>" UserError path.
    const result = await runMainSubprocess(["server", "create", "home", "-n"])
    assertEquals(result.code, 1)
    assertStringIncludes(result.stderr, "rostok: ")
    assertNoStackFrame(result.stderr)
  },
})

Deno.test({
  name: "subprocess: an unknown flag fails as rostok: <message>, no trace",
  async fn() {
    const result = await runMainSubprocess(["stack", "add", "traefik", "--bogus-flag"])
    assertEquals(result.code, 1)
    // Review fix — asserting the EXACT line (not just a "rostok: "
    // substring) matters: cliffy's own ValidationError message would
    // also satisfy a substring check if formatCliError mistakenly
    // treated it as an "unexpected error" (a bug) instead of a plain
    // user error — that branch also starts with "rostok: " but adds
    // "unexpected error: " plus a second "this is a bug ..." line.
    assertEquals(
      result.stderr.trim(),
      'rostok: Unknown option "--bogus-flag". Did you mean option "--catalog"?',
    )
    assertNoStackFrame(result.stderr)
  },
})
