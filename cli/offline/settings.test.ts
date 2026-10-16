import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { UserError } from "../errors.ts"
import { loadSettings, parseBackupPaths } from "./settings.ts"

async function project(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-offline-settings-" })
  for (const [name, content] of Object.entries(files)) {
    await Deno.writeTextFile(join(dir, name), content)
  }
  return dir
}

Deno.test("loadSettings: with only .env.root.age, says to run rostok env decrypt", async () => {
  const dir = await project({ ".env.root.age": "encrypted" })
  try {
    const error = await assertRejects(() => loadSettings(dir), UserError)
    assertStringIncludes(error.message, "rostok env decrypt")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("loadSettings: a missing BACKUP_PATHS names the key, the file and an example", async () => {
  const dir = await project({ ".env.root": "BACKUPS_PASSWORD=secret\n" })
  try {
    const error = await assertRejects(() => loadSettings(dir), UserError)
    assertStringIncludes(error.message, "BACKUP_PATHS not set in")
    assertStringIncludes(error.message, ".env.root")
    assertStringIncludes(error.message, `BACKUP_PATHS=[{"source":`)
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("loadSettings: a missing BACKUPS_PASSWORD names the key", async () => {
  const dir = await project({
    ".env.root": `BACKUP_PATHS=[{"source":"~/backups","target":"restic-repos"}]\n`,
  })
  try {
    const error = await assertRejects(() => loadSettings(dir), UserError)
    assertStringIncludes(error.message, "BACKUPS_PASSWORD not set in")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("loadSettings: reads both keys from .env.root", async () => {
  const dir = await project({
    ".env.root": `BACKUP_PATHS='[{"source":"~/backups","target":"restic-repos"}]'\n` +
      `BACKUPS_PASSWORD=secret\n`,
  })
  try {
    const settings = await loadSettings(dir)
    assertEquals(settings.backupPaths, [{ source: "~/backups", target: "restic-repos" }])
    assertEquals(settings.password, "secret")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("parseBackupPaths: refuses a target that would leave the drive folder", () => {
  for (const target of ["../etc", "a/b", "logs", ".."]) {
    let message = ""
    try {
      parseBackupPaths(`[{"source":"~/b","target":"${target}"}]`, ".env.root")
    } catch (error) {
      message = error instanceof UserError ? error.message : ""
    }
    assertStringIncludes(message, target, `target ${target} was accepted`)
  }
})
