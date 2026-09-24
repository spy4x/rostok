import { assertEquals, assertRejects } from "@std/assert"
import { join } from "@std/path"
import { UserError } from "../errors.ts"
import {
  runRemoteCommand,
  runRemoteShell,
  runRemoteSync,
  runRemoteSyncEntry,
  shQuote,
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

/** Install a fake `rsync` on PATH that prints its own argv, one per line. */
async function withFakeRsync<T>(fn: () => Promise<T>): Promise<T> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-rsync-argv-" })
  try {
    const script = `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done\n`
    await Deno.writeTextFile(join(binDir, "rsync"), script, { mode: 0o755 })
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

Deno.test("runRemoteSync: -e carries -p, ConnectTimeout and BatchMode; brackets a bare IPv6 destination", async () => {
  await withFakeRsync(async () => {
    const result = await runRemoteSync("root@[2001:db8::1]:2222", "/local/staging", "/srv/apps", [
      "-avhzru",
    ])
    const argv = result.output.split("\n").filter((l) => l.length > 0)
    assertEquals(argv, [
      "-avhzru",
      "-e",
      `ssh ${expectedOptions().join(" ")} -p 2222`,
      "--",
      "/local/staging/",
      "root@[2001:db8::1]:/srv/apps/",
    ])
  })
})

Deno.test("runRemoteSyncEntry: no trailing slash on the source; the remote parent path gets one", async () => {
  await withFakeRsync(async () => {
    const result = await runRemoteSyncEntry(
      "root@example.com",
      "/local/staging/stacks/traefik",
      "/srv/apps/stacks",
      ["-avhz", "--delete"],
    )
    const argv = result.output.split("\n").filter((l) => l.length > 0)
    assertEquals(argv, [
      "-avhz",
      "--delete",
      "-e",
      `ssh ${expectedOptions().join(" ")}`,
      "--",
      "/local/staging/stacks/traefik",
      "root@example.com:/srv/apps/stacks/",
    ])
  })
})

/**
 * Install a fake `ssh` that's a pure pass-through: it strips ssh's own
 * options and target, then `exec`s whatever argv rsync built for the
 * "remote" command AS SEPARATE ARGV ELEMENTS (never re-joined into one
 * shell string) — rsync's `-e` transport always invokes its remote
 * command that way. Since the command it built is `rsync --server ...`
 * with a REAL local path as the final argument (see the symlink test
 * below), this makes a REAL rsync-to-rsync protocol run end to end,
 * entirely on this machine — real symlink/--delete/mkdir semantics,
 * never a real network connection or a hand-rolled copy loop standing
 * in for them.
 */
async function withPassthroughFakeSsh<T>(fn: () => Promise<T>): Promise<T> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-passthrough-ssh-" })
  try {
    const script = `#!/usr/bin/env -S deno run --allow-run
const args = Deno.args
// Real ssh's own grammar: -o KEY=VALUE and -p PORT each consume the
// following arg too; an optional "--" ends the option list; the next
// token is the host; everything after that is the remote command,
// passed on as SEPARATE argv slots — exactly what a real
// "rsync --server" invocation needs to parse its own flags correctly.
// rsync itself may split "user@host" into "-l user host" before
// invoking its -e command (confirmed against a real rsync), so "-l" is
// consumed the same way "-o"/"-p" are.
// rsync's OWN invocation of its -e command never inserts "--" itself
// (unlike cli/server-keys.ts's sshArgs, used by the DIRECT ssh spawns),
// so this parses both shapes.
let i = 0
while (i < args.length) {
  const a = args[i]
  if (a === "-o" || a === "-p" || a === "-l") { i += 2; continue }
  if (a === "--") { i += 1; break }
  break
}
const remoteCommand = args.slice(i + 1)
const child = new Deno.Command(remoteCommand[0], {
  args: remoteCommand.slice(1),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn()
const status = await child.status
Deno.exit(status.code)
`
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

/** True if a real `rsync` binary is on PATH — the symlink tests below need one. */
const rsyncAvailable = await new Deno.Command("rsync", { args: ["--version"], stdout: "null" })
  .output().then((o) => o.success).catch(() => false)

Deno.test({
  name:
    "runRemoteSyncEntry against a REAL rsync: a symlinked destination is replaced, never followed into its target (#233 review)",
  ignore: !rsyncAvailable,
  fn: async () => {
    // Not a skip-when-missing shortcut (that's forbidden for a real CI
    // dependency) — rsync is a required, documented CI/dev dependency
    // for this repo now (.woodpecker.yml, this PR); `ignore` only
    // covers a machine that genuinely doesn't have it, the same way
    // Deno.test itself is skipped if the whole runtime were missing.
    await withPassthroughFakeSsh(async () => {
      const remoteRoot = await Deno.makeTempDir({ prefix: "rostok-symlink-remote-" })
      const stagingDir = await Deno.makeTempDir({ prefix: "rostok-symlink-staging-" })
      try {
        // The "remote": PATH_APPS/stacks/evil is a SYMLINK into
        // VOLUMES_PATH/evil-target, which holds real app data.
        await Deno.mkdir(join(remoteRoot, "apps", "stacks"), { recursive: true })
        const volumesTarget = join(remoteRoot, "volumes", "evil-target")
        await Deno.mkdir(volumesTarget, { recursive: true })
        await Deno.writeTextFile(join(volumesTarget, "important-data.txt"), "keep me")
        await Deno.symlink(
          volumesTarget,
          join(remoteRoot, "apps", "stacks", "evil"),
          { type: "dir" },
        )

        // The project's own staged copy of the "evil" stack.
        await Deno.mkdir(join(stagingDir, "evil"), { recursive: true })
        await Deno.writeTextFile(join(stagingDir, "evil", "compose.yml"), "new compose\n")

        const result = await runRemoteSyncEntry(
          "deploy@remote-test", // host is unused — the passthrough ssh ignores it
          join(stagingDir, "evil"),
          join(remoteRoot, "apps", "stacks"),
          ["-avhz", "--delete"],
        )
        if (!result.success) throw new Error(`rsync failed: ${result.error}`)

        // The symlink was replaced by a real directory with the
        // project's file — never merged into or deleted from its
        // former target.
        const evilEntry = await Deno.lstat(join(remoteRoot, "apps", "stacks", "evil"))
        assertEquals(evilEntry.isSymlink, false, "the symlink must be replaced, not followed")
        assertEquals(evilEntry.isDirectory, true)
        assertEquals(
          await Deno.readTextFile(join(remoteRoot, "apps", "stacks", "evil", "compose.yml")),
          "new compose\n",
        )

        // The volumes data the symlink used to point at is completely
        // untouched — still there, still readable, unmodified.
        assertEquals(
          await Deno.readTextFile(join(volumesTarget, "important-data.txt")),
          "keep me",
        )
      } finally {
        await Deno.remove(remoteRoot, { recursive: true })
        await Deno.remove(stagingDir, { recursive: true })
      }
    })
  },
})

Deno.test({
  name:
    "runRemoteSyncEntry against a REAL rsync: a STALE symlinked stack (about to be removed) is unlinked, never followed either (#233 review)",
  ignore: !rsyncAvailable,
  fn: async () => {
    // The stale-stack cleanup path removes a symlinked entry directly
    // (stale-stacks.ts), never via rsync — this test proves the OTHER
    // half of the same review point: even if a stale stack's directory
    // is still present as a symlink when a LATER, unrelated per-stack
    // sync runs (e.g. re-adding a stack under the same name after it
    // was removed then re-created as a symlink by something else), the
    // sync itself never writes into a symlink's target either.
    await withPassthroughFakeSsh(async () => {
      const remoteRoot = await Deno.makeTempDir({ prefix: "rostok-symlink-remote-" })
      const stagingDir = await Deno.makeTempDir({ prefix: "rostok-symlink-staging-" })
      try {
        await Deno.mkdir(join(remoteRoot, "apps", "stacks"), { recursive: true })
        const volumesTarget = join(remoteRoot, "volumes", "stale-target")
        await Deno.mkdir(volumesTarget, { recursive: true })
        await Deno.writeTextFile(join(volumesTarget, "important-data.txt"), "keep me too")
        await Deno.symlink(
          volumesTarget,
          join(remoteRoot, "apps", "stacks", "stale"),
          { type: "dir" },
        )

        await Deno.mkdir(join(stagingDir, "stale"), { recursive: true })
        await Deno.writeTextFile(join(stagingDir, "stale", "compose.yml"), "new compose\n")

        const result = await runRemoteSyncEntry(
          "deploy@remote-test",
          join(stagingDir, "stale"),
          join(remoteRoot, "apps", "stacks"),
          ["-avhz", "--delete"],
        )
        if (!result.success) throw new Error(`rsync failed: ${result.error}`)

        assertEquals(
          await Deno.readTextFile(join(volumesTarget, "important-data.txt")),
          "keep me too",
        )
      } finally {
        await Deno.remove(remoteRoot, { recursive: true })
        await Deno.remove(stagingDir, { recursive: true })
      }
    })
  },
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
