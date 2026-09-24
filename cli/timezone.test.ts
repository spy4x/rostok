// Tests for cli/timezone.ts — #212 (timezone detection order).
//
// Every source is injected — no shelling out, no real filesystem reads —
// so these tests only check the fallback order in `detectTimezone`.
// TIMEZONE configures containers running *on the server*, so the
// server's own zone (the `remote` source) wins over the operator's
// local machine whenever it's knowable.

import { assertEquals, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { detectTimezone, remoteTimedatectlTimezone } from "./timezone.ts"

/** Write a fake `ssh` on its own PATH entry, prepended for the duration of `fn`. */
async function withFakeSsh<T>(script: string, fn: () => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-timezone-fakessh-" })
  const scriptPath = join(dir, "ssh")
  await Deno.writeTextFile(scriptPath, script)
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

Deno.test("detectTimezone: the remote (server) zone wins over a different local zone", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve("Asia/Ho_Chi_Minh"),
    local: () => "Europe/Berlin",
    etcTimezone: () => Promise.resolve("America/New_York"),
  })
  assertEquals(tz, "Asia/Ho_Chi_Minh")
})

Deno.test("detectTimezone: an unreachable probe (remote returns undefined) falls back to the local zone", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve(undefined),
    local: () => "Europe/Berlin",
    etcTimezone: () => Promise.resolve("America/New_York"),
  })
  assertEquals(tz, "Europe/Berlin")
})

Deno.test("detectTimezone: falls through to /etc/timezone when remote and local Intl are both empty", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve(undefined),
    local: () => undefined,
    etcTimezone: () => Promise.resolve("America/New_York"),
  })
  assertEquals(tz, "America/New_York")
})

Deno.test("detectTimezone: UTC when every source is empty", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve(undefined),
    local: () => undefined,
    etcTimezone: () => Promise.resolve(undefined),
  })
  assertEquals(tz, "UTC")
})

Deno.test("detectTimezone: UTC when no sources are given at all and the real ones can't help", async () => {
  // The real `local` source (Intl) almost always resolves to something on
  // a real machine, so this only exercises the "no sources object at
  // all" call shape — not a true "everything empty" path. Kept as a
  // smoke test that the defaults don't throw.
  const tz = await detectTimezone()
  assertEquals(typeof tz, "string")
  assertEquals(tz.length > 0, true)
})

Deno.test("detectTimezone: an empty-string remote source falls through to local", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve(""),
    local: () => "Europe/Berlin",
    etcTimezone: () => Promise.resolve(undefined),
  })
  assertEquals(tz, "Europe/Berlin")
})

Deno.test("detectTimezone: a whitespace-only remote answer counts as empty, not a value", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve("   "),
    local: () => "Europe/Berlin",
    etcTimezone: () => Promise.resolve(undefined),
  })
  assertEquals(tz, "Europe/Berlin")
})

// A malformed/garbage remote answer (e.g. a shell profile printing a
// banner before timedatectl's own output landed on stdout) must not be
// accepted as TIMEZONE's value — it should fall through exactly like an
// empty answer.
Deno.test("detectTimezone: an invalid IANA name from the remote source is rejected, falls through", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve("Not/A/Real/Zone"),
    local: () => "Europe/Berlin",
    etcTimezone: () => Promise.resolve(undefined),
  })
  assertEquals(tz, "Europe/Berlin")
})

Deno.test("detectTimezone: an invalid IANA name from /etc/timezone is rejected, falls back to UTC", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve(undefined),
    local: () => undefined,
    etcTimezone: () => Promise.resolve("garbage-not-a-zone"),
  })
  assertEquals(tz, "UTC")
})

Deno.test("detectTimezone: a valid zone from /etc/timezone is accepted", async () => {
  const tz = await detectTimezone({
    remote: () => Promise.resolve(undefined),
    local: () => undefined,
    etcTimezone: () => Promise.resolve("Europe/Berlin"),
  })
  assertEquals(tz, "Europe/Berlin")
})

// #218 — review fix: nothing previously exercised
// `remoteTimedatectlTimezone`'s own ssh argv (only `detectTimezone`'s
// fallback order was tested, with `remote` always injected as a plain
// function) — reverting its `sshArgs` usage back to a raw target string
// stayed green. A fake `ssh` on PATH proves a ported SSH_ADDRESS reaches
// it as `-p <port>`, split from the host, not as one unresolvable
// "host:port" string.
Deno.test("remoteTimedatectlTimezone: a port in the target reaches ssh as -p <port>, split from the host", async () => {
  const argsFile = await Deno.makeTempFile({ prefix: "rostok-timezone-ssh-args-" })
  try {
    const script = `#!/bin/sh
echo "$@" > "${argsFile}"
echo "Europe/Berlin"
`
    const tz = await withFakeSsh(script, async () => {
      return await remoteTimedatectlTimezone("root@192.0.2.1:2222")
    })
    assertEquals(tz, "Europe/Berlin")
    const argv = (await Deno.readTextFile(argsFile)).trim()
    assertStringIncludes(argv, "-p 2222 -- root@192.0.2.1")
    assertStringIncludes(argv, "StrictHostKeyChecking=accept-new")
    assertStringIncludes(argv, "BatchMode=yes")
    assertEquals(argv.includes("192.0.2.1:2222"), false, argv)
  } finally {
    await Deno.remove(argsFile).catch(() => {})
  }
})
