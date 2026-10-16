import { assert, assertEquals, assertRejects } from "@std/assert"
import { UserError } from "../errors.ts"
import {
  blankDisk,
  cleanup,
  type Fake,
  type FakeDevice,
  makeFake,
  systemDisk,
} from "./fake-deps.test.ts"
import { type FormatOptions, runFormat } from "./format.ts"

const ERASE: FormatOptions = { drive: "sdc", nonInteractive: true, confirm: "sdc" }

/** sdc is blank until parted has run, then it shows the new partition. */
function partitionedAfterParted(fake: () => Fake): () => FakeDevice[] {
  return () => {
    const parted = fake().calls.some((c) => c.includes("parted"))
    const sdc = blankDisk()
    if (parted) sdc.children = [{ name: "sdc1", type: "part" }]
    return [systemDisk(), sdc]
  }
}

const erased = (fake: Fake) => fake.calls.some((c) => c.includes("parted") || c.includes("mkfs"))

Deno.test("format: with --confirm matching --drive, partitions and formats as OfflineBackups", async () => {
  const ref: { fake?: Fake } = {}
  const fake = await makeFake({ devices: partitionedAfterParted(() => ref.fake!) })
  ref.fake = fake
  try {
    await runFormat(fake.deps, { ...ERASE, drive: "/dev/sdc" })
    assertEquals(fake.calls.filter((c) => c.startsWith("sudo ") && c !== "sudo true"), [
      "sudo parted /dev/sdc --script mklabel gpt",
      "sudo parted /dev/sdc --script mkpart primary btrfs 0% 100%",
      "sudo mkfs.btrfs -f -L OfflineBackups /dev/sdc1",
    ])
  } finally {
    await cleanup(fake)
  }
})

Deno.test("format: -n alone, without --confirm, erases nothing", async () => {
  const fake = await makeFake({ devices: [systemDisk(), blankDisk()] })
  try {
    await assertRejects(
      () => runFormat(fake.deps, { ...ERASE, confirm: undefined }),
      UserError,
      "pass --confirm sdc to confirm",
    )
    assert(!erased(fake), fake.calls.join("\n"))
  } finally {
    await cleanup(fake)
  }
})

Deno.test("format: a --confirm naming another disk erases nothing", async () => {
  const fake = await makeFake({ devices: [systemDisk(), blankDisk()] })
  try {
    await assertRejects(
      () => runFormat(fake.deps, { ...ERASE, confirm: "sdb" }),
      UserError,
      "--confirm sdb does not match the disk sdc",
    )
    assert(!erased(fake))
  } finally {
    await cleanup(fake)
  }
})

Deno.test("format: refuses a disk with a mounted partition", async () => {
  const sdc = blankDisk()
  sdc.children = [{ name: "sdc1", type: "part", mountpoints: ["/run/media/me/stick"] }]
  const fake = await makeFake({ devices: [systemDisk(), sdc] })
  try {
    await assertRejects(
      () => runFormat(fake.deps, ERASE),
      UserError,
      "sdc has mounted partitions (/run/media/me/stick)",
    )
    assert(!erased(fake))
  } finally {
    await cleanup(fake)
  }
})

Deno.test("format: refuses the system disk even with a matching --confirm", async () => {
  const fake = await makeFake({ devices: [systemDisk(), blankDisk()] })
  try {
    await assertRejects(
      () => runFormat(fake.deps, { ...ERASE, drive: "nvme0n1", confirm: "nvme0n1" }),
      UserError,
      "holds the running system",
    )
    assert(!erased(fake))
  } finally {
    await cleanup(fake)
  }
})

Deno.test("format: without passwordless sudo and without a terminal, stops before erasing", async () => {
  const fake = await makeFake({ devices: [systemDisk(), blankDisk()], passwordlessSudo: false })
  try {
    await assertRejects(() => runFormat(fake.deps, ERASE), UserError, "format needs sudo")
    assert(!erased(fake))
    assert(!fake.calls.includes("sudo -v"))
  } finally {
    await cleanup(fake)
  }
})

Deno.test("format: at a terminal, a wrongly typed disk name erases nothing", async () => {
  const fake = await makeFake({
    devices: [systemDisk(), blankDisk()],
    terminal: true,
    prompts: ["sdb"],
  })
  try {
    await assertRejects(
      () => runFormat(fake.deps, { drive: "sdc", nonInteractive: false }),
      UserError,
      "format cancelled",
    )
    assert(!erased(fake))
  } finally {
    await cleanup(fake)
  }
})
