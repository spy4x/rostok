import { assertEquals, assertRejects, assertThrows } from "@std/assert"
import {
  createHomeAssistantBackupConfig,
  ensureHomeAssistantDataPath,
  resolveHomeAssistantDataPath,
  validateZigbeeDevicePath,
} from "./+lib.ts"

Deno.test("uses production backup defaults without local data path", () => {
  assertEquals(createHomeAssistantBackupConfig(), {
    name: "home-assistant",
    sourcePaths: "default",
    pathsToChangeOwnership: "default",
    containers: { stop: "default" },
  })
})

Deno.test("uses explicit local path and local container", () => {
  assertEquals(createHomeAssistantBackupConfig("/srv/rostok/home-assistant"), {
    name: "home-assistant",
    sourcePaths: ["/srv/rostok/home-assistant"],
    pathsToChangeOwnership: [],
    containers: { stop: ["hl-home-assistant-local"] },
  })
})

Deno.test("rejects relative and broad local data paths", () => {
  assertThrows(() => resolveHomeAssistantDataPath("./data"), Error, "must be absolute")
  assertThrows(() => resolveHomeAssistantDataPath("/home"), Error, "dedicated subdirectory")
  assertThrows(
    () => resolveHomeAssistantDataPath("/srv/rostok"),
    Error,
    "must end with /home-assistant",
  )
})

Deno.test("creates dedicated data path and rejects symlinks", async () => {
  const root = await Deno.makeTempDir({ prefix: "ha-data-path-" })
  const dataPath = `${root}/data/home-assistant`
  const linkPath = `${root}/linked/home-assistant`
  await Deno.mkdir(`${root}/linked`, { recursive: true })
  await Deno.symlink(dataPath, linkPath)

  try {
    assertEquals(await ensureHomeAssistantDataPath(dataPath), dataPath)
    await assertRejects(
      () => ensureHomeAssistantDataPath(linkPath),
      Error,
      "cannot be a symlink",
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("rejects data path inside Git worktree", async () => {
  const root = await Deno.makeTempDir({ prefix: "ha-git-path-" })
  await Deno.writeTextFile(`${root}/.git`, "gitdir: synthetic")

  try {
    await assertRejects(
      () => ensureHomeAssistantDataPath(`${root}/data/home-assistant`),
      Error,
      "cannot be inside a Git worktree",
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("requires stable Zigbee symlink to character device", async () => {
  const root = await Deno.makeTempDir({ prefix: "ha-zigbee-path-" })
  const validLink = `${root}/valid-device`
  const invalidTarget = `${root}/regular-file`
  const invalidLink = `${root}/invalid-device`
  await Deno.symlink("/dev/null", validLink)
  await Deno.writeTextFile(invalidTarget, "not a device")
  await Deno.symlink(invalidTarget, invalidLink)

  try {
    assertEquals(await validateZigbeeDevicePath(validLink, root), validLink)
    await assertRejects(
      () => validateZigbeeDevicePath(invalidLink, root),
      Error,
      "must target a character device",
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
