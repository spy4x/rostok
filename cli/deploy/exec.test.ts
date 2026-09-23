import { assertEquals, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { runRemoteCommand, runRemoteShell, shQuote } from "./exec.ts"

/** Install a fake `ssh` on PATH that prints its own argv, one per line, as JSON. */
async function withFakeSsh<T>(fn: () => Promise<T>): Promise<T> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-ssh-argv-" })
  try {
    const script = `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done\n`
    await Deno.writeTextFile(join(binDir, "ssh"), script, { mode: 0o755 })
    const previousPath = Deno.env.get("PATH") ?? ""
    Deno.env.set("PATH", `${binDir}:${previousPath}`)
    try {
      return await fn()
    } finally {
      Deno.env.set("PATH", previousPath)
    }
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
}

Deno.test("runRemoteCommand: puts -- before the target, ahead of the rest of argv", async () => {
  await withFakeSsh(async () => {
    const result = await runRemoteCommand("root@example.com", ["id", "-u"])
    const argv = result.output.split("\n").filter((l) => l.length > 0)
    assertEquals(argv, ["--", "root@example.com", "id", "-u"])
  })
})

Deno.test("runRemoteShell: puts -- before the target, ahead of the script", async () => {
  await withFakeSsh(async () => {
    const result = await runRemoteShell("root@example.com", "echo hi")
    const argv = result.output.split("\n").filter((l) => l.length > 0)
    assertEquals(argv, ["--", "root@example.com", "echo hi"])
  })
})

Deno.test("runRemoteCommand: -- stops ssh's own option parser from reading a malicious target as a flag", async () => {
  // Real end-to-end proof against the real `ssh` binary (not a fake): a
  // target starting with `-` would otherwise be read as an ssh option
  // (e.g. -oProxyCommand=<cmd>, which runs <cmd> locally). With `--` in
  // front, ssh must treat it as a literal (invalid) hostname instead —
  // it fails on "invalid hostname", never on "unknown option".
  const result = await runRemoteCommand("-oProxyCommand=false", ["id", "-u"])
  assertEquals(result.success, false)
  assertStringIncludes(result.error.toLowerCase(), "hostname")
})

Deno.test("shQuote: wraps a value in single quotes", () => {
  assertEquals(shQuote("hello"), "'hello'")
})

Deno.test("shQuote: escapes an embedded single quote", () => {
  assertEquals(shQuote("it's"), "'it'\\''s'")
})

Deno.test("shQuote: neutralizes $(...) and backticks (a literal, inert string once single-quoted)", () => {
  const quoted = shQuote("$(touch pwned)`touch pwned2`")
  assertEquals(quoted, "'$(touch pwned)`touch pwned2`'")
})
