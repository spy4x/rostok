import { assert, assertEquals, assertRejects } from "@std/assert"
import { join } from "@std/path"
import { UserError } from "../errors.ts"
import { cleanup, type Fake, makeFake } from "./fake-deps.test.ts"
import { type RestoreOptions, runRestore } from "./restore.ts"

const UNATTENDED: RestoreOptions = {
  drive: "sdb",
  nonInteractive: true,
  overwriteLocal: false,
  eject: true,
}

const ran = (fake: Fake, prefix: string) => fake.calls.some((c) => c.startsWith(prefix))

/** A drive that holds a copy of the repository `app`. */
async function filledDrive(fake: Fake): Promise<void> {
  await Deno.mkdir(join(fake.mountDir, "restic-repos", "app"), { recursive: true })
  await Deno.writeTextFile(join(fake.mountDir, "restic-repos", "app", "config"), "")
}

Deno.test("restore: -n without --overwrite-local refuses before touching the drive", async () => {
  const fake = await makeFake()
  try {
    await assertRejects(
      () => runRestore(fake.deps, UNATTENDED),
      UserError,
      "pass --overwrite-local to allow it",
    )
    assertEquals(fake.calls, [])
  } finally {
    await cleanup(fake)
  }
})

Deno.test("restore: --overwrite-local copies the drive back and checks the local copies", async () => {
  const fake = await makeFake()
  try {
    await filledDrive(fake)
    await runRestore(fake.deps, { ...UNATTENDED, overwriteLocal: true })
    assert(
      ran(fake, `rsync -ah --info=progress2 --delete ${join(fake.mountDir, "restic-repos")}/`),
      fake.calls.join("\n"),
    )
    assert(ran(fake, `restic -r ${join(fake.home, "backups", "app")} check`))
    assert(ran(fake, "udisksctl power-off -b /dev/sdb"))
  } finally {
    await cleanup(fake)
  }
})

Deno.test("restore: at a terminal, a wrongly typed disk name changes nothing", async () => {
  const fake = await makeFake({ terminal: true, prompts: ["sda"] })
  try {
    await filledDrive(fake)
    await assertRejects(
      () => runRestore(fake.deps, { ...UNATTENDED, nonInteractive: false }),
      UserError,
      "restore cancelled",
    )
    assert(!ran(fake, "rsync"), fake.calls.join("\n"))
    assert(ran(fake, "udisksctl unmount"))
  } finally {
    await cleanup(fake)
  }
})

Deno.test("restore: at a terminal, typing the disk name restores", async () => {
  const fake = await makeFake({ terminal: true, prompts: ["/dev/sdb"] })
  try {
    await filledDrive(fake)
    await runRestore(fake.deps, { ...UNATTENDED, nonInteractive: false })
    assert(ran(fake, "rsync"))
  } finally {
    await cleanup(fake)
  }
})
