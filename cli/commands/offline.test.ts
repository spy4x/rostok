import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { ValidationError } from "@cliffy/command"
import { buildCommand } from "../+main.ts"
import { cleanup, makeFake } from "../offline/fake-deps.test.ts"
import { buildOfflineCommand } from "./offline.ts"

// Fake deps even where parsing should fail first: if validation ever
// regressed, the run must not reach the real lsblk or udisksctl.

Deno.test("offline backup: an unknown --check value is rejected with the allowed values", async () => {
  const fake = await makeFake()
  try {
    const cmd = buildOfflineCommand(() => fake.deps).throwErrors()
    const error = await assertRejects(
      () => cmd.parse(["backup", "--drive", "sdb", "--check", "quick"]),
      ValidationError,
    )
    assertStringIncludes(error.message, `Expected values: "fast", "full", "skip"`)
    assertEquals(fake.calls, [])
  } finally {
    await cleanup(fake)
  }
})

Deno.test("offline verify: --check skip is not a verify mode", async () => {
  const fake = await makeFake()
  try {
    const cmd = buildOfflineCommand(() => fake.deps).throwErrors()
    await assertRejects(
      () => cmd.parse(["verify", "--drive", "sdb", "--check", "skip"]),
      ValidationError,
    )
    assertEquals(fake.calls, [])
  } finally {
    await cleanup(fake)
  }
})

Deno.test("rostok offline: is registered on the root command", () => {
  assertEquals(buildCommand().getCommand("offline")?.getName(), "offline")
})

Deno.test("offline backup: flags reach the run (/dev/sdb, -n, --no-eject)", async () => {
  const fake = await makeFake()
  try {
    const cmd = buildOfflineCommand(() => fake.deps).throwErrors()
    await cmd.parse(["backup", "--drive", "/dev/sdb", "-n", "--smart", "skip", "--no-eject"])
    assert(fake.calls.includes("udisksctl unmount -b /dev/sdb1"), fake.calls.join("\n"))
    assert(!fake.calls.some((c) => c.startsWith("udisksctl power-off")))
  } finally {
    await cleanup(fake)
  }
})

Deno.test("offline format: -n without --confirm never reaches parted", async () => {
  const fake = await makeFake()
  try {
    const cmd = buildOfflineCommand(() => fake.deps).throwErrors()
    await assertRejects(
      () => cmd.parse(["format", "--drive", "sdb", "-n"]),
      Error,
      "--confirm sdb",
    )
    assert(!fake.calls.some((c) => c.includes("parted")))
  } finally {
    await cleanup(fake)
  }
})

Deno.test("offline help: shows exit codes and an example for cron or an agent", () => {
  const help = buildOfflineCommand().getHelp()
  assertStringIncludes(help, "Exit codes:")
  assertStringIncludes(help, "rostok offline backup --drive sdb -n")
  for (const sub of ["status", "backup", "verify", "restore", "format"]) {
    assertStringIncludes(help, sub)
  }
})
