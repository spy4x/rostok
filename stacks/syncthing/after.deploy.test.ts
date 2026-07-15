// Tests for stacks/syncthing/after.deploy.ts pure reconciliation logic.

import { assertEquals, assertObjectMatch } from "@std/assert"

import type { SyncthingConfig } from "./before.deploy.ts"
import {
  type ApiDevice,
  type ApiFolder,
  buildDeviceNameMap,
  computeDeviceChanges,
  computeFolderChanges,
} from "./after.deploy.ts"

const OFFSITE_ID = "SXYX5HB-OFFSITE-PLACEHOLDER-IDENTIFIER-DUMMY0"
const HOME_ID = "HOME-LOCAL-DEVICE-IDENTIFIER-PLACEHOLDER-DUMMY0"
const LAPTOP_ID = "LAPTOP-PLACEHOLDER-IDENTIFIER-DUMMY0"
const MINI_PC_ID = "MINIPC-PLACEHOLDER-IDENTIFIER-DUMMY0"
const PHONE_ID = "PHONE-PLACEHOLDER-IDENTIFIER-DUMMY0"

function makeConfig(
  overrides: Partial<SyncthingConfig> = {},
): SyncthingConfig {
  return {
    data_dir: "~/appdata",
    mounts: [
      { host: "~/ssd/sync", container: "/sync" },
      { host: "~/hdd", container: "/hdd" },
    ],
    folders: [
      {
        id: "archive",
        path: "/sync/archive",
        type: "sendreceive",
        devices: ["spy4x-home", "spy4x-offsite", "spy4x-laptop"],
      },
      {
        id: "backups",
        path: "/hdd/sync/backups",
        type: "sendreceive",
        devices: ["spy4x-home", "spy4x-offsite"],
      },
    ],
    devices: [
      { id: HOME_ID, name: "spy4x-home" },
      { id: OFFSITE_ID, name: "spy4x-offsite" },
      { id: LAPTOP_ID, name: "spy4x-laptop" },
      { id: MINI_PC_ID, name: "spy4x-mini-pc" },
      { id: PHONE_ID, name: "spy4x-phone" },
    ],
    ...overrides,
  }
}

const myDeviceId = HOME_ID

Deno.test("buildDeviceNameMap: indexes by name", () => {
  const map = buildDeviceNameMap(makeConfig())
  assertEquals(map.get("spy4x-home"), HOME_ID)
  assertEquals(map.get("spy4x-offsite"), OFFSITE_ID)
  assertEquals(map.size, 5)
})

Deno.test("buildDeviceNameMap: empty devices", () => {
  const map = buildDeviceNameMap(makeConfig({ devices: [] }))
  assertEquals(map.size, 0)
})

Deno.test("computeDeviceChanges: all new → adds", () => {
  const cfg = makeConfig({
    devices: [
      { id: HOME_ID, name: "spy4x-home" },
      { id: OFFSITE_ID, name: "spy4x-offsite" },
    ],
  })
  const changes = computeDeviceChanges(cfg, [])
  assertEquals(changes.length, 2)
  assertEquals(changes[0].kind, "add")
  assertEquals(changes[1].kind, "add")
})

Deno.test("computeDeviceChanges: existing matches → skip; name drift → rename", () => {
  const currentDevices: ApiDevice[] = [
    { deviceID: HOME_ID, name: "old-home-name" },
    { deviceID: OFFSITE_ID, name: "spy4x-offsite" },
  ]
  const changes = computeDeviceChanges(makeConfig(), currentDevices)
  const homeChange = changes.find((c) => c.id === HOME_ID)!
  const offsiteChange = changes.find((c) => c.id === OFFSITE_ID)!

  assertEquals(homeChange.kind, "rename")
  assertEquals(homeChange.kind === "rename" && homeChange.from, "old-home-name")
  assertEquals(homeChange.kind === "rename" && homeChange.to, "spy4x-home")

  assertEquals(offsiteChange.kind, "skip")
})

Deno.test("computeFolderChanges: brand-new folder → add with resolved IDs", () => {
  const cfg = makeConfig()
  const nameMap = buildDeviceNameMap(cfg)
  const changes = computeFolderChanges(cfg, [], myDeviceId, nameMap)
  assertEquals(changes.length, 2)
  assertEquals(changes[0].kind, "add")
  assertEquals(changes[1].kind, "add")
  // First folder (archive) should have 3 devices (home, offsite, laptop)
  assertEquals(
    changes[0].kind === "add" && changes[0].resolvedDeviceIds.length,
    3,
  )
  // Second folder (backups) should have 2 devices (home, offsite)
  assertEquals(
    changes[1].kind === "add" && changes[1].resolvedDeviceIds.length,
    2,
  )
})

Deno.test("computeFolderChanges: existing with same path and devices → skip", () => {
  const cfg = makeConfig()
  const currentFolders: ApiFolder[] = [
    {
      id: "archive",
      path: "/sync/archive",
      type: "sendreceive",
      devices: [
        { deviceID: HOME_ID },
        { deviceID: OFFSITE_ID },
        { deviceID: LAPTOP_ID },
      ],
    },
    {
      id: "backups",
      path: "/hdd/sync/backups",
      type: "sendreceive",
      devices: [
        { deviceID: HOME_ID },
        { deviceID: OFFSITE_ID },
      ],
    },
  ]
  const changes = computeFolderChanges(
    cfg,
    currentFolders,
    myDeviceId,
    buildDeviceNameMap(cfg),
  )
  assertEquals(changes.every((c) => c.kind === "skip"), true)
})

Deno.test("computeFolderChanges: path-only change → update-path", () => {
  const cfg = makeConfig()
  const currentFolders: ApiFolder[] = [
    {
      id: "archive",
      path: "/sync/OLD-archive", // different from config
      type: "sendreceive",
      devices: [
        { deviceID: HOME_ID },
        { deviceID: OFFSITE_ID },
        { deviceID: LAPTOP_ID },
      ],
    },
    {
      id: "backups",
      path: "/hdd/sync/backups",
      type: "sendreceive",
      devices: [
        { deviceID: HOME_ID },
        { deviceID: OFFSITE_ID },
      ],
    },
  ]
  const changes = computeFolderChanges(
    cfg,
    currentFolders,
    myDeviceId,
    buildDeviceNameMap(cfg),
  )
  const archiveChange = changes.find((c) => c.id === "archive")!
  assertEquals(archiveChange.kind, "update-path")
  if (archiveChange.kind === "update-path") {
    assertEquals(archiveChange.oldPath, "/sync/OLD-archive")
    assertEquals(archiveChange.newPath, "/sync/archive")
  }
})

Deno.test("computeFolderChanges: device-list-only change → update-devices with preserved passwords", () => {
  const cfg = makeConfig()
  // backups folder in YAML has [home, offsite]; current has [home, offsite, laptop]
  const currentFolders: ApiFolder[] = [
    {
      id: "archive",
      path: "/sync/archive",
      type: "sendreceive",
      devices: [
        { deviceID: HOME_ID },
        { deviceID: OFFSITE_ID },
        { deviceID: LAPTOP_ID },
      ],
    },
    {
      id: "backups",
      path: "/hdd/sync/backups",
      type: "sendreceive",
      devices: [
        { deviceID: HOME_ID, encryptionPassword: "home-pass" },
        { deviceID: OFFSITE_ID, encryptionPassword: "secret-offsite-pwd" },
        { deviceID: LAPTOP_ID, encryptionPassword: "laptop-pass" },
      ],
    },
  ]
  const changes = computeFolderChanges(
    cfg,
    currentFolders,
    myDeviceId,
    buildDeviceNameMap(cfg),
  )
  // archive matches → skip, backups drifts in devices → update-devices
  assertEquals(changes.length, 2)
  const backupsChange = changes.find((c) => c.id === "backups")!
  assertEquals(backupsChange.kind, "update-devices")
  if (backupsChange.kind === "update-devices") {
    // Two devices in YAML: home + offsite. Their passwords preserved.
    assertEquals(backupsChange.mergedDevices.length, 2)
    const home = backupsChange.mergedDevices.find((d) => d.deviceID === HOME_ID)
    const offsite = backupsChange.mergedDevices.find((d) => d.deviceID === OFFSITE_ID)
    assertEquals(home?.encryptionPassword, "home-pass")
    assertEquals(offsite?.encryptionPassword, "secret-offsite-pwd")
  }
})

Deno.test("computeFolderChanges: both path and devices change → update-both", () => {
  const cfg = makeConfig()
  const currentFolders: ApiFolder[] = [
    {
      id: "archive",
      path: "/OLD/sync/archive",
      type: "sendreceive",
      devices: [
        { deviceID: HOME_ID, encryptionPassword: "home-pass" },
      ], // only home, YAML wants 3
    },
    {
      id: "backups",
      path: "/hdd/sync/backups",
      type: "sendreceive",
      devices: [
        { deviceID: HOME_ID },
        { deviceID: OFFSITE_ID },
      ],
    },
  ]
  const changes = computeFolderChanges(
    cfg,
    currentFolders,
    myDeviceId,
    buildDeviceNameMap(cfg),
  )
  const archiveChange = changes.find((c) => c.id === "archive")!
  assertEquals(archiveChange.kind, "update-both")
  if (archiveChange.kind === "update-both") {
    assertEquals(archiveChange.oldPath, "/OLD/sync/archive")
    assertEquals(archiveChange.newPath, "/sync/archive")
    assertEquals(archiveChange.mergedDevices.length, 3)
  }
})

Deno.test("computeFolderChanges: folder references unknown device name → throws", () => {
  const cfg = makeConfig({
    folders: [{
      id: "broken",
      path: "/sync/broken",
      devices: ["not-a-real-device"],
    }],
  })
  let threw = false
  try {
    computeFolderChanges(cfg, [], myDeviceId, buildDeviceNameMap(cfg))
  } catch (err) {
    threw = true
    assertEquals(
      (err as Error).message.includes("not-a-real-device"),
      true,
    )
  }
  assertEquals(threw, true)
})

Deno.test("computeFolderChanges: local device in folder.devices preserved when computing diff", () => {
  // The local device appears in BOTH the YAML folder list AND the running
  // config. The diff must not flag this as a device mismatch.
  const cfg = makeConfig()
  const currentFolders: ApiFolder[] = [
    {
      id: "archive",
      path: "/sync/archive",
      type: "sendreceive",
      devices: [
        { deviceID: HOME_ID },
        { deviceID: OFFSITE_ID },
        { deviceID: LAPTOP_ID },
      ],
    },
  ]
  const changes = computeFolderChanges(
    cfg,
    currentFolders,
    myDeviceId,
    buildDeviceNameMap(cfg),
  )
  // Should skip — both the YAML and current include the local device
  assertEquals(changes[0].kind, "skip")
})

Deno.test("end-to-end: device add + folder add", () => {
  const cfg = makeConfig()
  const currentDevices: ApiDevice[] = []
  const currentFolders: ApiFolder[] = []
  const nameMap = buildDeviceNameMap(cfg)

  const deviceChanges = computeDeviceChanges(cfg, currentDevices)
  assertEquals(deviceChanges.filter((c) => c.kind === "add").length, 5)

  const folderChanges = computeFolderChanges(cfg, currentFolders, myDeviceId, nameMap)
  // archive has 3 devices (home, offsite, laptop), backups has 2 (home, offsite)
  const archiveAdd = folderChanges.find(
    (c) => c.kind === "add" && c.folder.id === "archive",
  )
  const backupsAdd = folderChanges.find(
    (c) => c.kind === "add" && c.folder.id === "backups",
  )
  assertObjectMatch(archiveAdd?.kind === "add" ? archiveAdd : {}, { kind: "add" })
  assertObjectMatch(backupsAdd?.kind === "add" ? backupsAdd : {}, { kind: "add" })
})
