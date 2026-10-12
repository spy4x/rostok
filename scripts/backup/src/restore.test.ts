// Restore of a stack whose backup.ts says "default": the config is read from
// a stacks folder the way the task reads it, and the snapshot is a hand-built
// tree shaped like the output of `restic restore --target <root>`.

import { assertEquals, assertRejects, assertThrows } from "@std/assert"
import { join } from "@std/path"
import { applyRestore, literalIncludePattern, planRestore } from "./restore.ts"

/** Runs `fn` in a fresh temp folder and removes it afterwards. */
async function withTempDir(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "restore-test-" })
  try {
    await fn(root)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
}

// config.ts reads VOLUMES_PATH once, when +lib.ts first loads, so the tests
// that load a backup.ts share one folder and use a stack name each.
const configRoot = await Deno.makeTempDir({ prefix: "restore-test-config-" })
globalThis.addEventListener("unload", () => Deno.removeSync(configRoot, { recursive: true }))

async function loadConfigModule(): Promise<typeof import("./config.ts")> {
  const env: Record<string, string> = {
    SSH_USER: "deploy",
    PATH_APPS: join(configRoot, "apps"),
    VOLUMES_PATH: join(configRoot, "volumes"),
    PATH_SYNC: join(configRoot, "sync"),
    SERVER_NAME: "test",
  }
  const previous = new Map(Object.keys(env).map((key) => [key, Deno.env.get(key)]))
  try {
    for (const [key, value] of Object.entries(env)) Deno.env.set(key, value)
    return await import("./config.ts")
  } finally {
    for (const [key, value] of previous) {
      value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value)
    }
  }
}

/** Loads the backup config of one stack the way the restore task does. */
async function loadStackConfig(stack: string) {
  const { BackupConfigProcessor } = await loadConfigModule()
  const configs = await BackupConfigProcessor.loadConfigurations(
    join(configRoot, "apps", "stacks"),
    join(configRoot, "apps", "configs", "backup"),
  )
  const config = configs.find((c) => c.name === stack)
  if (!config) throw new Error(`no backup config for ${stack}`)
  return { BackupConfigProcessor, config }
}

async function writeStackConfig(stack: string): Promise<void> {
  const dir = join(configRoot, "apps", "stacks", stack)
  await Deno.mkdir(dir, { recursive: true })
  await Deno.writeTextFile(
    join(dir, "backup.ts"),
    `export default {
  name: "${stack}",
  sourcePaths: "default",
  pathsToChangeOwnership: "default",
  containers: { stop: "default" },
}\n`,
  )
}

Deno.test('restore: a stack with "default" paths gets its volume back, old data kept', async () => {
  await writeStackConfig("notes")
  const volume = join(configRoot, "volumes", "notes")
  await Deno.mkdir(volume, { recursive: true })
  await Deno.writeTextFile(join(volume, "db.sqlite"), "broken")

  const { BackupConfigProcessor, config } = await loadStackConfig("notes")
  assertEquals(BackupConfigProcessor.normalize(config), true)
  assertEquals(config.sourcePaths, [volume])
  assertEquals(config.pathsToChangeOwnership, [volume])
  assertEquals(config.containers?.stop, ["__compose__"])

  // What `restic restore --target <restoreRoot>` leaves behind.
  const restoreRoot = join(configRoot, "volumes", ".restore-1")
  await Deno.mkdir(join(restoreRoot, volume, "attachments"), { recursive: true })
  await Deno.writeTextFile(join(restoreRoot, volume, "db.sqlite"), "good")
  await Deno.writeTextFile(join(restoreRoot, volume, "attachments", "a.txt"), "file")
  await Deno.chmod(join(restoreRoot, volume, "db.sqlite"), 0o600)
  await Deno.chmod(join(restoreRoot, volume), 0o750)

  const restoredInode = (await Deno.stat(join(restoreRoot, volume, "db.sqlite"))).ino

  const matches = planRestore(config.sourcePaths as string[], [volume])
  assertEquals(matches, [{ snapshotPath: volume, to: volume }])
  const kept = await applyRestore([{ from: join(restoreRoot, volume), to: volume }], "stamp")

  assertEquals(await Deno.readTextFile(join(volume, "db.sqlite")), "good")
  assertEquals(await Deno.readTextFile(join(volume, "attachments", "a.txt")), "file")
  assertEquals((await Deno.stat(join(volume, "db.sqlite"))).mode! & 0o777, 0o600)
  assertEquals((await Deno.stat(volume)).mode! & 0o777, 0o750)
  // The very files restic wrote, not copies: a copy made by root is root's.
  assertEquals((await Deno.stat(join(volume, "db.sqlite"))).ino, restoredInode)
  assertEquals(kept, [`${volume}.backup-stamp`])
  assertEquals(await Deno.readTextFile(join(kept[0], "db.sqlite")), "broken")
})

Deno.test("restore: the config resolves when the volume folder is gone", async () => {
  await writeStackConfig("gone")

  const forRestore = await loadStackConfig("gone")
  assertEquals(forRestore.BackupConfigProcessor.normalize(forRestore.config), true)
  assertEquals(forRestore.config.sourcePaths, [join(configRoot, "volumes", "gone")])

  // The nightly backup still refuses a folder that is not there.
  const forBackup = await loadStackConfig("gone")
  assertEquals(forBackup.BackupConfigProcessor.validateAndNormalize(forBackup.config), false)
})

Deno.test("restore: a missing volume is put back where the config names it", async () => {
  await withTempDir(async (root) => {
    const volume = join(root, "volumes", "notes")
    const restoreRoot = join(root, "volumes", ".restore-1")
    await Deno.mkdir(join(restoreRoot, volume), { recursive: true })
    await Deno.writeTextFile(join(restoreRoot, volume, "db.sqlite"), "good")

    const kept = await applyRestore([{ from: join(restoreRoot, volume), to: volume }], "stamp")

    assertEquals(kept, [])
    assertEquals(await Deno.readTextFile(join(volume, "db.sqlite")), "good")
  })
})

Deno.test("restore: a snapshot taken before the volumes moved lands at the new path", () => {
  assertEquals(
    planRestore(
      ["/new/volumes/notes", "/new/volumes/notes-db"],
      ["/old/volumes/notes", "/old/volumes/notes-db"],
    ),
    [
      { snapshotPath: "/old/volumes/notes", to: "/new/volumes/notes" },
      { snapshotPath: "/old/volumes/notes-db", to: "/new/volumes/notes-db" },
    ],
  )
})

Deno.test("restore: refuses to guess between two snapshot folders of the same name", () => {
  assertThrows(
    () => planRestore(["/new/data"], ["/a/data", "/b/data"]),
    Error,
    "/a/data, /b/data",
  )
  assertThrows(
    () => planRestore(["/new/data"], ["/a/other"]),
    Error,
    "Cannot tell which folder",
  )
})

Deno.test("restore: a folder the snapshot holds exactly is never matched by name too", () => {
  // "/x/data" is in the snapshot as itself, so it cannot also stand in for "/y/data".
  assertThrows(
    () => planRestore(["/y/data", "/x/data"], ["/x/data"]),
    Error,
    "Cannot tell which folder",
  )
})

Deno.test("restore: nothing is touched when the snapshot lacks one of the folders", async () => {
  await withTempDir(async (root) => {
    const first = join(root, "volumes", "first")
    const second = join(root, "volumes", "second")
    const restoreRoot = join(root, "volumes", ".restore-1")
    await Deno.mkdir(first, { recursive: true })
    await Deno.writeTextFile(join(first, "live.txt"), "live")
    await Deno.mkdir(join(restoreRoot, first), { recursive: true })

    await assertRejects(
      () =>
        applyRestore([
          { from: join(restoreRoot, first), to: first },
          { from: join(restoreRoot, second), to: second },
        ], "stamp"),
      Error,
      "nothing was changed",
    )
    assertEquals(await Deno.readTextFile(join(first, "live.txt")), "live")
    assertEquals([...Deno.readDirSync(join(root, "volumes"))].map((e) => e.name).sort(), [
      ".restore-1",
      "first",
    ])
  })
})

Deno.test("restore: when one folder cannot be put in place, the others go back", async () => {
  await withTempDir(async (root) => {
    const first = join(root, "volumes", "first")
    const restoredFirst = join(root, "volumes", ".restore-1", "first")
    const restoredSecond = join(root, "volumes", ".restore-2", "second")
    await Deno.mkdir(first, { recursive: true })
    await Deno.writeTextFile(join(first, "db"), "live")
    await Deno.mkdir(restoredFirst, { recursive: true })
    await Deno.writeTextFile(join(restoredFirst, "db"), "snapshot")
    await Deno.mkdir(restoredSecond, { recursive: true })
    // A file where the second destination's parent folder should be.
    await Deno.writeTextFile(join(root, "blocked"), "")

    await assertRejects(
      () =>
        applyRestore([
          { from: restoredFirst, to: first },
          { from: restoredSecond, to: join(root, "blocked", "second") },
        ], "stamp"),
      Error,
      "Every folder is back as it was before the restore.",
    )
    assertEquals(await Deno.readTextFile(join(first, "db")), "live")
    assertEquals(await Deno.readTextFile(join(restoredFirst, "db")), "snapshot")
    assertEquals([...Deno.readDirSync(join(root, "volumes"))].map((e) => e.name).sort(), [
      ".restore-1",
      ".restore-2",
      "first",
    ])
  })
})

Deno.test("restore: a folder whose own move fails gets its previous data back", async () => {
  await withTempDir(async (root) => {
    // A folder cannot be renamed into itself, as root or as anyone else.
    const from = join(root, "x")
    const to = join(from, "sub", "vol")
    await Deno.mkdir(to, { recursive: true })
    await Deno.writeTextFile(join(to, "db"), "live")

    await assertRejects(
      () => applyRestore([{ from, to }], "stamp"),
      Error,
      "Every folder is back as it was before the restore.",
    )
    assertEquals(await Deno.readTextFile(join(to, "db")), "live")
    assertEquals([...Deno.readDirSync(join(from, "sub"))].map((e) => e.name), ["vol"])
  })
})

Deno.test("escapes every restic pattern character of a snapshot path", () => {
  assertEquals(literalIncludePattern("/vol/data[1]"), "/vol/data\\[1]")
  assertEquals(literalIncludePattern("/vol/a*b"), "/vol/a\\*b")
  assertEquals(literalIncludePattern("/vol/q?z"), "/vol/q\\?z")
  assertEquals(literalIncludePattern("/vol/b\\c"), "/vol/b\\\\c")
  assertEquals(literalIncludePattern("/vol/**/[a-z]?"), "/vol/\\*\\*/\\[a-z]\\?")
})

Deno.test("leaves a snapshot path without pattern characters as it is", () => {
  assertEquals(literalIncludePattern("/srv/volumes/gatus data-1.x"), "/srv/volumes/gatus data-1.x")
})
