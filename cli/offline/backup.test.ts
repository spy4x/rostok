import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { UserError } from "../errors.ts"
import { type BackupOptions, runBackup } from "./backup.ts"
import {
  backupDrive,
  blankDisk,
  cleanup,
  type Fake,
  makeFake,
  systemDisk,
} from "./fake-deps.test.ts"

const NIGHTLY: BackupOptions = {
  drive: "sdb",
  nonInteractive: true,
  check: "fast",
  smart: "skip",
  deleteMissing: false,
  eject: true,
}

const ran = (fake: Fake, prefix: string) => fake.calls.some((c) => c.startsWith(prefix))

/** Puts a repository on the drive that is no longer in the local source. */
async function driveOnlyRepo(fake: Fake): Promise<void> {
  await Deno.mkdir(join(fake.mountDir, "restic-repos", "old-app"), { recursive: true })
}

Deno.test("backup: copies, checks, writes README and a log, then ejects", async () => {
  const fake = await makeFake()
  try {
    await runBackup(fake.deps, NIGHTLY)
    assert(ran(fake, "rsync -ah --info=progress2 --delete"), fake.calls.join("\n"))
    assert(ran(fake, `restic -r ${join(fake.mountDir, "restic-repos", "app")} check`))
    assert(ran(fake, "udisksctl power-off -b /dev/sdb"))
    const readme = await Deno.readTextFile(join(fake.mountDir, "README.md"))
    assertStringIncludes(readme, "rostok offline restore --drive")
    assertStringIncludes(readme, "deno install -g -A -n rostok jsr:@rostok/cli")
    const logs = [...Deno.readDirSync(join(fake.mountDir, "logs"))].map((e) => e.name)
    assertEquals(logs.length, 1)
    assertStringIncludes(logs[0], "_success.log")
    assertStringIncludes(fake.stdout.join("\n"), "Drive: ejected, safe to unplug")
  } finally {
    await cleanup(fake)
  }
})

Deno.test("backup: on a drive without an OfflineBackups partition, names the format command and never formats", async () => {
  const fake = await makeFake({ devices: [systemDisk(), blankDisk()] })
  try {
    await assertRejects(
      () => runBackup(fake.deps, { ...NIGHTLY, drive: "sdc" }),
      UserError,
      "rostok offline format --drive sdc",
    )
    assert(!ran(fake, "sudo parted") && !ran(fake, "sudo mkfs"), fake.calls.join("\n"))
    assert(!ran(fake, "parted") && !ran(fake, "mkfs"))
  } finally {
    await cleanup(fake)
  }
})

Deno.test("backup: -n alone refuses to delete drive-only repositories and never runs rsync", async () => {
  const fake = await makeFake()
  try {
    await driveOnlyRepo(fake)
    await assertRejects(
      () => runBackup(fake.deps, NIGHTLY),
      UserError,
      "Pass --delete-missing to allow it",
    )
    assert(!ran(fake, "rsync"), fake.calls.join("\n"))
    assertStringIncludes(fake.stdout.join("\n"), "restic-repos/old-app")
  } finally {
    await cleanup(fake)
  }
})

Deno.test("backup: --delete-missing lets rsync delete drive-only repositories", async () => {
  const fake = await makeFake()
  try {
    await driveOnlyRepo(fake)
    await runBackup(fake.deps, { ...NIGHTLY, deleteMissing: true })
    assert(ran(fake, "rsync"))
  } finally {
    await cleanup(fake)
  }
})

Deno.test("backup: at a terminal, answering no to the delete question stops before copying", async () => {
  const fake = await makeFake({ terminal: true, confirms: [false] })
  try {
    await driveOnlyRepo(fake)
    await assertRejects(
      () => runBackup(fake.deps, { ...NIGHTLY, nonInteractive: false }),
      UserError,
      "the drive is unchanged",
    )
    assertEquals(fake.asked, ["Delete them from the drive?"])
    assert(!ran(fake, "rsync"))
  } finally {
    await cleanup(fake)
  }
})

Deno.test("backup: a drive owned by another user is handed to this user by numeric id", async () => {
  const fake = await makeFake()
  try {
    // Cron often leaves $USER unset; the ownership fix must not depend on it.
    const owner = (await Deno.stat(fake.mountDir)).uid!
    fake.deps.uid = owner + 1
    await runBackup(fake.deps, NIGHTLY)
    assert(ran(fake, `sudo chown -R ${owner + 1} ${fake.mountDir}`), fake.calls.join("\n"))
  } finally {
    await cleanup(fake)
  }
})

Deno.test("backup: an already-mounted partition is reused and left mounted", async () => {
  const fake = await makeFake({
    devices: (_, mountDir) => backupDrive({ mountpoints: [mountDir] }),
  })
  try {
    await runBackup(fake.deps, NIGHTLY)
    assert(!ran(fake, "udisksctl"), fake.calls.join("\n"))
    assert(ran(fake, "rsync"))
    assertStringIncludes(fake.stdout.join("\n"), "Drive: left mounted, as it was before")
  } finally {
    await cleanup(fake)
  }
})

Deno.test("backup: --no-eject unmounts but never powers the drive off", async () => {
  const fake = await makeFake()
  try {
    await runBackup(fake.deps, { ...NIGHTLY, eject: false })
    assert(ran(fake, "udisksctl unmount -b /dev/sdb1"))
    assert(!ran(fake, "udisksctl power-off"), fake.calls.join("\n"))
  } finally {
    await cleanup(fake)
  }
})

Deno.test("backup: a failed repository check exits 1 after the summary, the log and the eject", async () => {
  const fake = await makeFake({ failing: ["restic"] })
  try {
    await assertRejects(() => runBackup(fake.deps, NIGHTLY), UserError, "finished with failures")
    assert(ran(fake, "udisksctl power-off"))
    const logs = [...Deno.readDirSync(join(fake.mountDir, "logs"))].map((e) => e.name)
    assertStringIncludes(logs.join(), "_failed.log")
  } finally {
    await cleanup(fake)
  }
})

Deno.test("backup: --check skip copies, runs no restic check and says the check was skipped", async () => {
  const fake = await makeFake()
  try {
    await runBackup(fake.deps, { ...NIGHTLY, check: "skip" })
    assert(ran(fake, "rsync"))
    assert(!ran(fake, "restic"))
    assertStringIncludes(fake.stdout.join("\n"), "--check skip was given")
  } finally {
    await cleanup(fake)
  }
})

Deno.test("backup: without passwordless sudo and without a terminal, skips SMART and says how to run it", async () => {
  const fake = await makeFake({ passwordlessSudo: false })
  try {
    await runBackup(fake.deps, { ...NIGHTLY, smart: "short" })
    assert(!ran(fake, "sudo smartctl"), fake.calls.join("\n"))
    assert(!ran(fake, "sudo -v"))
    assertStringIncludes(fake.stderr.join("\n"), "sudo smartctl -t short /dev/sdb")
    assertStringIncludes(fake.stdout.join("\n"), "skipped: sudo needs a password")
  } finally {
    await cleanup(fake)
  }
})

Deno.test("backup: refuses to run outside Linux", async () => {
  const fake = await makeFake({ os: "darwin" })
  try {
    await assertRejects(() => runBackup(fake.deps, NIGHTLY), UserError, "Linux only")
    assertEquals(fake.calls, [])
  } finally {
    await cleanup(fake)
  }
})
