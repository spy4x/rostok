import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert"
import { UserError } from "../errors.ts"
import { normalizeDriveName, resolveDisk } from "./disks.ts"
import { cleanup, makeFake } from "./fake-deps.test.ts"

Deno.test("normalizeDriveName: accepts sda and /dev/sda alike", () => {
  assertEquals(normalizeDriveName("sda"), "sda")
  assertEquals(normalizeDriveName("/dev/sda"), "sda")
})

Deno.test("normalizeDriveName: rejects a path or anything that is not a device name", () => {
  for (const input of ["/dev/../sda", "sda; rm", "/mnt/sda", ""]) {
    assertThrows(() => normalizeDriveName(input), UserError, "--drive takes a disk name")
  }
})

Deno.test("resolveDisk: /dev/sdb resolves to the disk sdb", async () => {
  const fake = await makeFake()
  try {
    assertEquals((await resolveDisk(fake.deps, "/dev/sdb", false)).name, "sdb")
  } finally {
    await cleanup(fake)
  }
})

Deno.test("resolveDisk: refuses a partition and names the disks", async () => {
  const fake = await makeFake()
  try {
    const error = await assertRejects(() => resolveDisk(fake.deps, "sdb1", false), UserError)
    assertStringIncludes(error.message, "sdb1 is a partition, not a whole disk")
    assertStringIncludes(error.message, "sdb ")
  } finally {
    await cleanup(fake)
  }
})

Deno.test("resolveDisk: refuses the disk the system runs from", async () => {
  const fake = await makeFake()
  try {
    await assertRejects(
      () => resolveDisk(fake.deps, "nvme0n1", false),
      UserError,
      "holds the running system (/boot/efi, / mounted from it)",
    )
  } finally {
    await cleanup(fake)
  }
})

Deno.test("resolveDisk: without --drive and without a terminal, lists the disks", async () => {
  const fake = await makeFake()
  try {
    const error = await assertRejects(() => resolveDisk(fake.deps, undefined, false), UserError)
    assertStringIncludes(error.message, "no drive given: pass --drive <disk>")
    assertStringIncludes(error.message, "sdb        1.8T  Backup Plus  [OfflineBackups]")
    assertStringIncludes(error.message, "nvme0n1")
    assertEquals(fake.asked, [])
  } finally {
    await cleanup(fake)
  }
})

Deno.test("resolveDisk: at a terminal, the picker starts on cancel and greys out the system disk", async () => {
  const fake = await makeFake({ terminal: true, select: "sdb" })
  try {
    assertEquals((await resolveDisk(fake.deps, undefined, true)).name, "sdb")
    assertEquals(fake.selectOptions[0], { name: "cancel", value: "" })
    assertEquals(
      fake.selectOptions.slice(1).map((o) => [o.value, o.disabled]),
      [["nvme0n1", true], ["sdb", false]],
    )
  } finally {
    await cleanup(fake)
  }
})

Deno.test("resolveDisk: choosing cancel in the picker stops", async () => {
  const fake = await makeFake({ terminal: true, select: "" })
  try {
    await assertRejects(() => resolveDisk(fake.deps, undefined, true), UserError, "no disk chosen")
  } finally {
    await cleanup(fake)
  }
})
