import { assertEquals, assertRejects } from "@std/assert"
import { join } from "@std/path"
import { UserError } from "../errors.ts"
import { parseSshAddress } from "../server-keys.ts"
import {
  rsyncEntrySyncArgs,
  rsyncSyncArgs,
  runRemoteCommand,
  runRemoteShell,
  runRemoteSync,
  runRemoteSyncEntry,
  shQuote,
  stripControlChars,
} from "./exec.ts"

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

// Mirrors exec.ts's own check — a batch-mode option is expected iff this
// test process's own stdin isn't a TTY (true in CI, possibly false when
// run interactively at a terminal).
function expectedOptions(): string[] {
  const opts = ["-o", "ConnectTimeout=10"]
  let isTerminal = false
  try {
    isTerminal = Deno.stdin.isTerminal()
  } catch {
    // not a TTY
  }
  if (!isTerminal) opts.push("-o", "BatchMode=yes")
  return opts
}

Deno.test("runRemoteCommand: -p <port>, the standard options, -- then the rest of argv", async () => {
  await withFakeSsh(async () => {
    const result = await runRemoteCommand("root@example.com", ["id", "-u"])
    const argv = result.output.split("\n").filter((l) => l.length > 0)
    assertEquals(argv, [...expectedOptions(), "--", "root@example.com", "id", "-u"])
  })
})

Deno.test("runRemoteCommand: carries the port from SSH_ADDRESS", async () => {
  await withFakeSsh(async () => {
    const result = await runRemoteCommand("root@192.0.2.1:2222", ["id", "-u"])
    const argv = result.output.split("\n").filter((l) => l.length > 0)
    assertEquals(argv, [...expectedOptions(), "-p", "2222", "--", "root@192.0.2.1", "id", "-u"])
  })
})

Deno.test("runRemoteShell: puts -- before the target, ahead of the script", async () => {
  await withFakeSsh(async () => {
    const result = await runRemoteShell("root@example.com", "echo hi")
    const argv = result.output.split("\n").filter((l) => l.length > 0)
    assertEquals(argv, [...expectedOptions(), "--", "root@example.com", "echo hi"])
  })
})

Deno.test("runRemoteCommand: an [IPv6]:port SSH_ADDRESS reaches ssh as a bare host + -p", async () => {
  // ssh gets the target and -p as separate argv slots, so the brackets
  // that disambiguated the SSH_ADDRESS string aren't needed (or added)
  // once it's parsed — see targetHost's comment in server-keys.ts.
  await withFakeSsh(async () => {
    const result = await runRemoteCommand("[2001:db8::1]:2222", ["id", "-u"])
    const argv = result.output.split("\n").filter((l) => l.length > 0)
    assertEquals(argv, [...expectedOptions(), "-p", "2222", "--", "2001:db8::1", "id", "-u"])
  })
})

Deno.test("runRemoteCommand: rejects a malicious SSH_ADDRESS before ssh is ever spawned", async () => {
  // A target starting with `-` would otherwise be read as an ssh option
  // (e.g. -oProxyCommand=<cmd>, which runs <cmd> locally). parseSshAddress
  // (cli/server-keys.ts) throws before runCommand builds any argv at
  // all — no ssh process is spawned, fake or real.
  await withFakeSsh(async () => {
    await assertRejects(
      () => runRemoteCommand("-oProxyCommand=false", ["id", "-u"]),
      UserError,
      "invalid SSH_ADDRESS",
    )
  })
})

Deno.test("rsyncSyncArgs: -e carries -p, ConnectTimeout and BatchMode; trailing slash on both source and destination", () => {
  const target = parseSshAddress("root@[2001:db8::1]:2222")
  const argv = rsyncSyncArgs(target, "/local/staging", "/srv/apps", ["-avhzru"], {
    batchMode: true,
  })
  assertEquals(argv, [
    "-avhzru",
    "-e",
    "ssh -o ConnectTimeout=10 -o BatchMode=yes -p 2222",
    "--",
    "/local/staging/",
    "root@[2001:db8::1]:/srv/apps/",
  ])
})

Deno.test("rsyncEntrySyncArgs: no trailing slash on the source; the remote parent path gets one", () => {
  const target = parseSshAddress("root@example.com")
  const argv = rsyncEntrySyncArgs(
    target,
    "/local/staging/stacks/traefik",
    "/srv/apps/stacks",
    ["-avhz", "--delete"],
    { batchMode: true },
  )
  assertEquals(argv, [
    "-avhz",
    "--delete",
    "-e",
    "ssh -o ConnectTimeout=10 -o BatchMode=yes",
    "--",
    "/local/staging/stacks/traefik",
    "root@example.com:/srv/apps/stacks/",
  ])
})

Deno.test("rsyncEntrySyncArgs: never trails the source with a slash, for any stack name (mutation gap)", () => {
  // The whole point of runRemoteSyncEntry over runRemoteSync — a
  // trailing slash here would make rsync merge CONTENTS into the
  // destination instead of replacing it as one named entry, the shape
  // that lets a symlinked destination be followed into its target
  // instead of replaced (#233 review — see this function's own comment
  // in exec.ts; the actual rsync behavior is a manual VM step, not an
  // automated one, since no test here may spawn rsync at all).
  const target = parseSshAddress("root@example.com")
  for (const name of ["alpha", "a-longer-stack-name"]) {
    const argv = rsyncEntrySyncArgs(target, `/staging/stacks/${name}`, "/srv/apps/stacks", [], {})
    const source = argv[argv.length - 2]
    assertEquals(source.endsWith("/"), false, `source must not end with "/": ${source}`)
    assertEquals(source, `/staging/stacks/${name}`)
  }
})

// #282 — SSH_ADDRESS=local runs every step on this machine.

/**
 * Put a fake `ssh` and a fake `rsync` first on PATH for `fn`. The fake
 * ssh only records that it ran (a marker file) and exits 97, so a local
 * step that wrongly reached ssh either fails or leaves the marker. The
 * fake rsync prints its argv, one per line, and copies nothing. Neither
 * calls any other program (the marker is written by a shell
 * redirection), and both refuse to run inside one another (depth guard).
 */
async function withFakeSshAndRsync<T>(
  fn: (sshRan: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-local-" })
  const marker = join(binDir, "ssh-ran")
  const guard = `[ -n "$ROSTOK_FAKE_BIN_DEPTH" ] && exit 98\nexport ROSTOK_FAKE_BIN_DEPTH=1\n`
  try {
    await Deno.writeTextFile(join(binDir, "ssh"), `#!/bin/sh\n${guard}: > '${marker}'\nexit 97\n`, {
      mode: 0o755,
    })
    await Deno.writeTextFile(
      join(binDir, "rsync"),
      `#!/bin/sh\n${guard}for a in "$@"; do printf '%s\\n' "$a"; done\n`,
      { mode: 0o755 },
    )
    const previousPath = Deno.env.get("PATH") ?? ""
    Deno.env.set("PATH", `${binDir}:${previousPath}`)
    try {
      return await fn(async () => {
        try {
          await Deno.stat(marker)
          return true
        } catch {
          return false
        }
      })
    } finally {
      Deno.env.set("PATH", previousPath)
    }
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
}

Deno.test("runRemoteShell: a local server runs the script on this machine and never spawns ssh", async () => {
  await withFakeSshAndRsync(async (sshRan) => {
    const result = await runRemoteShell("local", `printf '%s' "$((40 + 2))"`)
    assertEquals(result, { success: true, code: 0, output: "42", error: "" })
    assertEquals(await sshRan(), false)
  })
})

Deno.test("runRemoteCommand: a local server runs argv as is, never through ssh", async () => {
  // Each element stays its own argument ("a b" is not split in two).
  await withFakeSshAndRsync(async (sshRan) => {
    const result = await runRemoteCommand("local", ["printf", "%s|", "a b", "c"])
    assertEquals(result.output, "a b|c|")
    assertEquals(await sshRan(), false)
  })
})

Deno.test("runRemoteSync: a local server runs rsync with the same flags, no -e, plain destination", async () => {
  await withFakeSshAndRsync(async (sshRan) => {
    const result = await runRemoteSync("local", "/tmp/staging", "/srv/apps", [
      "-avhz",
      "--exclude=/stacks",
      "--delete",
    ])
    const argv = result.output.split("\n").filter((l) => l.length > 0)
    assertEquals(argv, [
      "-avhz",
      "--exclude=/stacks",
      "--delete",
      "--",
      "/tmp/staging/",
      "/srv/apps/",
    ])
    assertEquals(await sshRan(), false)
  })
})

Deno.test("runRemoteSyncEntry: a local server syncs the entry into the plain parent path, no -e", async () => {
  await withFakeSshAndRsync(async (sshRan) => {
    const result = await runRemoteSyncEntry(
      "local",
      "/tmp/staging/stacks/traefik",
      "/srv/apps/stacks",
      ["-avhz", "--delete"],
    )
    const argv = result.output.split("\n").filter((l) => l.length > 0)
    assertEquals(argv, [
      "-avhz",
      "--delete",
      "--",
      "/tmp/staging/stacks/traefik",
      "/srv/apps/stacks/",
    ])
    assertEquals(await sshRan(), false)
  })
})

Deno.test("runRemoteSync: a remote server still syncs over ssh with -e and host:path", async () => {
  await withFakeSshAndRsync(async () => {
    const result = await runRemoteSync("root@192.0.2.1", "/tmp/staging", "/srv/apps", ["-avhz"])
    const argv = result.output.split("\n").filter((l) => l.length > 0)
    assertEquals(argv, [
      "-avhz",
      "-e",
      ["ssh", ...expectedOptions()].join(" "),
      "--",
      "/tmp/staging/",
      "root@192.0.2.1:/srv/apps/",
    ])
  })
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

Deno.test("stripControlChars: removes escape and bell bytes, keeps the rest", () => {
  const input = "x\x1b]0;PWNED\x07 real text"
  assertEquals(stripControlChars(input), "x]0;PWNED real text")
})

Deno.test("stripControlChars: keeps newlines and tabs", () => {
  assertEquals(stripControlChars("line1\n\tline2"), "line1\n\tline2")
})

Deno.test("stripControlChars: removes C1 control characters (\\x80-\\x9f)", () => {
  // Some terminals treat an 8-bit C1 code (e.g. 0x9b, "CSI") the same
  // as a `\x1b`-prefixed escape sequence — this is a second encoding
  // of the same attack the \x1b/\x07 test above already covers, not a
  // duplicate of it.
  const input = "x\x9bPWNED\x9c real text"
  assertEquals(stripControlChars(input), "xPWNED real text")
})
