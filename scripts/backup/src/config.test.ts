import { assertEquals } from "@std/assert"
import { join } from "@std/path"
import { BackupConfigProcessor } from "./config.ts"
import { BackupStatus } from "./types.ts"

Deno.test("imports only requested backup configurations", async () => {
  const root = await Deno.makeTempDir({ prefix: "backup-config-filter-" })
  const stacksPath = join(root, "stacks")
  const configsPath = join(root, "configs")
  const selectedPath = join(stacksPath, "selected")
  const skippedPath = join(stacksPath, "skipped")
  await Deno.mkdir(selectedPath, { recursive: true })
  await Deno.mkdir(skippedPath, { recursive: true })
  await Deno.mkdir(configsPath, { recursive: true })

  const selectedMarker = join(root, "selected-imported")
  const skippedMarker = join(root, "skipped-imported")
  await Deno.writeTextFile(
    join(selectedPath, "backup.ts"),
    `Deno.writeTextFileSync(${JSON.stringify(selectedMarker)}, "yes")\n` +
      `export default { name: "selected", sourcePaths: [] }\n`,
  )
  await Deno.writeTextFile(
    join(skippedPath, "backup.ts"),
    `Deno.writeTextFileSync(${JSON.stringify(skippedMarker)}, "yes")\n` +
      `export default { name: "skipped", sourcePaths: [] }\n`,
  )

  try {
    const backups = await BackupConfigProcessor.loadConfigurations(
      stacksPath,
      configsPath,
      ["selected"],
    )
    assertEquals(backups.map((backup) => backup.name), ["selected"])
    assertEquals(await exists(selectedMarker), true)
    assertEquals(await exists(skippedMarker), false)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("preserves exported name separately from trusted discovery name", async () => {
  const root = await Deno.makeTempDir({ prefix: "backup-config-name-" })
  const stacksPath = join(root, "stacks")
  const configsPath = join(root, "configs")
  const stackPath = join(stacksPath, "expected")
  await Deno.mkdir(stackPath, { recursive: true })
  await Deno.mkdir(configsPath, { recursive: true })
  await Deno.writeTextFile(
    join(stackPath, "backup.ts"),
    `export default { name: "different", sourcePaths: [] }\n`,
  )

  try {
    const [backup] = await BackupConfigProcessor.loadConfigurations(
      stacksPath,
      configsPath,
      ["expected"],
    )
    assertEquals(backup.name, "different")
    assertEquals(backup.discoveryName, "expected")
    assertEquals(backup.status, BackupStatus.IN_PROGRESS)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path)
    return true
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false
    throw error
  }
}
