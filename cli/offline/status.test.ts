import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { UserError } from "../errors.ts"
import { cleanup, makeFake } from "./fake-deps.test.ts"
import { runStatus } from "./status.ts"

Deno.test("status: a missing required tool is listed and exits 1", async () => {
  const fake = await makeFake({ tools: ["lsblk", "rsync", "udisksctl"] })
  try {
    await assertRejects(() => runStatus(fake.deps), UserError, "not ready: missing restic")
    const out = fake.stdout.join("\n")
    assertStringIncludes(out, "✗ restic")
    assertStringIncludes(out, "✗ smartctl")
    assertStringIncludes(out, "✓ rsync")
  } finally {
    await cleanup(fake)
  }
})

Deno.test("status: with settings and tools in place, shows sizes and disks and mounts nothing", async () => {
  const fake = await makeFake()
  try {
    await runStatus(fake.deps)
    const out = fake.stdout.join("\n")
    assertStringIncludes(out, "~/backups → restic-repos  (2 KB)")
    assertStringIncludes(out, "(offline backup drive)")
    assertStringIncludes(out, "Ready: rostok offline backup --drive <disk>")
    assertEquals(fake.calls.filter((c) => c.startsWith("udisksctl")), [])
  } finally {
    await cleanup(fake)
  }
})

Deno.test("status: a missing .env.root is reported and exits 1", async () => {
  const fake = await makeFake({}, null)
  try {
    await assertRejects(() => runStatus(fake.deps), UserError, "missing settings")
    assertStringIncludes(fake.stdout.join("\n"), ".env.root not found")
  } finally {
    await cleanup(fake)
  }
})

Deno.test("status: outside Linux, says the command is Linux only", async () => {
  const fake = await makeFake({ os: "windows" })
  try {
    await assertRejects(() => runStatus(fake.deps), UserError, "Linux only")
  } finally {
    await cleanup(fake)
  }
})
