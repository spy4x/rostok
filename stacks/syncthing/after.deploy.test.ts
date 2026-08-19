// Tests for stacks/syncthing/after.deploy.ts pure reconciliation logic.

import { assertEquals } from "@std/assert"

import { type Device, type FolderRef, validateConfig } from "./before.deploy.ts"
import {
  type ApiDevice,
  type ApiFolder,
  deepEqual,
  desiredDevice,
  desiredFolder,
  isDeviceArray,
  isFolderArray,
  isSystemStatus,
  resolveFolderDeviceIds,
} from "./after.deploy.ts"

const HOME_ID = "HOME-LOCAL-DEVICE-IDENTIFIER-PLACEHOLDER-DUMMY0"
const OFFSITE_ID = "SXYX5HB-OFFSITE-PLACEHOLDER-IDENTIFIER-DUMMY0"
const LAPTOP_ID = "LAPTOP-PLACEHOLDER-IDENTIFIER-DUMMY0"

const nameMap = new Map<string, string>([
  ["spy4x-home", HOME_ID],
  ["spy4x-offsite", OFFSITE_ID],
  ["spy4x-laptop", LAPTOP_ID],
])

const currentFolder: ApiFolder = {
  id: "archive",
  label: "archive",
  path: "/OLD/path",
  type: "sendreceive",
  paused: false,
  versioning: {
    type: "",
    params: {},
    cleanupIntervalS: 3600,
    fsPath: "",
    fsType: "basic",
  },
  devices: [
    { deviceID: HOME_ID, encryptionPassword: "home-secret" },
    { deviceID: OFFSITE_ID, encryptionPassword: "offsite-secret" },
  ],
}

// ── deepEqual ─────────────────────────────────────────────────────────

Deno.test("deepEqual: primitives", () => {
  assertEquals(deepEqual(1, 1), true)
  assertEquals(deepEqual("a", "a"), true)
  assertEquals(deepEqual(null, undefined), true)
  assertEquals(deepEqual(undefined, undefined), true)
  assertEquals(deepEqual(1, "1"), false)
})

Deno.test("deepEqual: arrays", () => {
  assertEquals(deepEqual([1, 2, 3], [1, 2, 3]), true)
  assertEquals(deepEqual([1, 2], [1, 2, 3]), false)
  assertEquals(deepEqual([1, 2, 3], [1, 3, 2]), false)
})

Deno.test("deepEqual: nested objects", () => {
  assertEquals(
    deepEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } }),
    true,
  )
  assertEquals(
    deepEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } }),
    false,
  )
  // Absent key is treated as undefined: same as explicit undefined
  assertEquals(deepEqual({ a: 1 }, { a: 1, b: undefined }), true)
  // Absent key is NOT same as a defined value
  assertEquals(deepEqual({ a: 1 }, { a: 1, b: 2 }), false)
})

Deno.test("deepEqual: treats null and undefined equivalently", () => {
  assertEquals(deepEqual({ a: null }, { a: undefined }), true)
  assertEquals(deepEqual({ a: null }, { b: undefined }), true)
  assertEquals(deepEqual({ a: null }, {}), true)
})

// ── resolveFolderDeviceIds ────────────────────────────────────────────

Deno.test("resolveFolderDeviceIds: maps names to IDs", () => {
  const folder: FolderRef = {
    id: "f",
    path: "/sync/f",
    devices: ["spy4x-home", "spy4x-offsite"],
  }
  assertEquals(resolveFolderDeviceIds(folder, nameMap), [
    HOME_ID,
    OFFSITE_ID,
  ])
})

Deno.test("resolveFolderDeviceIds: throws on unknown name", () => {
  const folder: FolderRef = {
    id: "f",
    path: "/sync/f",
    devices: ["does-not-exist"],
  }
  let threw = false
  try {
    resolveFolderDeviceIds(folder, nameMap)
  } catch (err) {
    threw = true
    assertEquals((err as Error).message.includes("does-not-exist"), true)
  }
  assertEquals(threw, true)
})

// ── desiredFolder ─────────────────────────────────────────────────────

Deno.test("desiredFolder: applies YAML overrides on top of current", () => {
  const yaml: FolderRef = {
    id: "archive",
    path: "/sync/archive",
    type: "sendreceive",
    devices: ["spy4x-home", "spy4x-laptop"],
  }
  const desired = desiredFolder(yaml, currentFolder, nameMap)
  assertEquals(desired.path, "/sync/archive")
  assertEquals(desired.devices.length, 2)
  // Encryption passwords preserved
  const home = desired.devices.find((d) => d.deviceID === HOME_ID)
  assertEquals(home?.encryptionPassword, "home-secret")
  // Laptop is new in YAML, gets empty password
  const laptop = desired.devices.find((d) => d.deviceID === LAPTOP_ID)
  assertEquals(laptop?.encryptionPassword, "")
  // Offsite dropped from YAML → not in desired.devices
  assertEquals(desired.devices.some((d) => d.deviceID === OFFSITE_ID), false)
})

Deno.test("desiredFolder: applies versioning override", () => {
  const yaml: FolderRef = {
    id: "archive",
    path: "/sync/archive",
    versioning: {
      type: "trashcan",
      params: { cleanoutDays: "180", keep: "5" },
    },
    devices: ["spy4x-home"],
  }
  const desired = desiredFolder(yaml, currentFolder, nameMap)
  assertEquals(desired.versioning?.type, "trashcan")
  assertEquals(desired.versioning?.params?.cleanoutDays, "180")
  assertEquals(desired.versioning?.params?.keep, "5")
  // Other versioning fields preserved
  assertEquals(desired.versioning?.cleanupIntervalS, 3600)
})

Deno.test("desiredFolder: preserves undeclared fields (deep snapshot)", () => {
  const yaml: FolderRef = {
    id: "archive",
    path: "/sync/archive",
    devices: ["spy4x-home"],
  }
  const desired = desiredFolder(yaml, currentFolder, nameMap)
  // current has paused:false — preserved
  assertEquals(desired.paused, false)
})

Deno.test("desiredFolder: applies paused override", () => {
  const yaml: FolderRef = {
    id: "archive",
    path: "/sync/archive",
    paused: true,
    devices: ["spy4x-home"],
  }
  const desired = desiredFolder(yaml, currentFolder, nameMap)
  assertEquals(desired.paused, true)
})

// ── desiredDevice ─────────────────────────────────────────────────────

Deno.test("desiredDevice: applies addresses override", () => {
  const current: ApiDevice = {
    deviceID: OFFSITE_ID,
    name: "spy4x-offsite",
    addresses: ["dynamic"],
    compression: "metadata",
  }
  const desired = desiredDevice(
    { id: OFFSITE_ID, name: "spy4x-offsite", addresses: ["tcp://1.2.3.4:22000"] },
    current,
  )
  assertEquals(desired.addresses, ["tcp://1.2.3.4:22000"])
})

Deno.test("desiredDevice: applies untrusted override", () => {
  const current: ApiDevice = {
    deviceID: OFFSITE_ID,
    name: "spy4x-offsite",
    addresses: ["dynamic"],
    untrusted: false,
  }
  const desired = desiredDevice(
    { id: OFFSITE_ID, name: "spy4x-offsite", untrusted: true },
    current,
  )
  assertEquals(desired.untrusted, true)
})

Deno.test("desiredDevice: preserves undeclared fields", () => {
  const current: ApiDevice = {
    deviceID: OFFSITE_ID,
    name: "spy4x-offsite",
    addresses: ["dynamic"],
    compression: "metadata",
    paused: true,
    introducer: true,
  }
  const desired = desiredDevice(
    { id: OFFSITE_ID, name: "spy4x-offsite" },
    current,
  )
  assertEquals(desired.compression, "metadata")
  assertEquals(desired.paused, true)
  assertEquals(desired.introducer, true)
})

// ── validation rejects new fields with wrong types ───────────────────

Deno.test("validateConfig: rejects non-string addresses", () => {
  try {
    validateConfig({
      data_dir: "~/x",
      devices: [{ id: "A-A-A", name: "n", addresses: [123] }],
    })
    throw new Error("should have thrown")
  } catch (err) {
    assertEquals(
      (err as { errors: string[] }).errors.some((e) => e.includes("addresses")),
      true,
    )
  }
})

Deno.test("validateConfig: rejects versioning without type", () => {
  try {
    validateConfig({
      data_dir: "~/x",
      folders: [{
        id: "f",
        path: "/sync/f",
        versioning: { params: {} } as never, // missing type
        devices: [],
      }],
      devices: [],
    })
    throw new Error("should have thrown")
  } catch (err) {
    assertEquals(
      (err as { errors: string[] }).errors.some((e) => e.includes("versioning.type")),
      true,
    )
  }
})

Deno.test("validateConfig: accepts full folder + device options", () => {
  validateConfig({
    data_dir: "~/x",
    mounts: [{ host: "~/x", container: "/x" }],
    folders: [{
      id: "f",
      path: "/x/f",
      type: "sendreceive",
      paused: true,
      versioning: { type: "trashcan", params: { cleanoutDays: "180" } },
      devices: ["a"],
    }],
    devices: [{ id: "A-A", name: "a", addresses: ["tcp://1.1.1.1:22000"], untrusted: true }],
  })
})

void validateConfig as never // suppress unused warning when test file imports for type only

void (function devTypeCheck(): Device {
  // Ensure Device exported type stays valid against current usage
  return { id: "x", name: "y" }
})()

// ── API response validators (runtime shape checks) ────────────────────

Deno.test("isSystemStatus: accepts valid shape, rejects garbage", () => {
  assertEquals(isSystemStatus({ myID: "AAA-BBB-CCC" }), true)
  assertEquals(isSystemStatus({}), false)
  assertEquals(isSystemStatus({ myID: 42 }), false)
  assertEquals(isSystemStatus({ myID: "no_dashes_here" }), false)
  assertEquals(isSystemStatus(null), false)
  assertEquals(isSystemStatus("string"), false)
})

Deno.test("isFolderArray: accepts valid, rejects bad entries", () => {
  assertEquals(isFolderArray([]), true)
  assertEquals(
    isFolderArray([
      { id: "f1", path: "/x/f1", devices: [{ deviceID: "X" }] },
    ]),
    true,
  )
  assertEquals(isFolderArray([{ id: "f", path: "/x" }]), false) // missing devices
  assertEquals(isFolderArray([{ id: "f", devices: [] }]), false) // missing path
  assertEquals(isFolderArray([{ id: 42, path: "/x", devices: [] }]), false)
})

Deno.test("isDeviceArray: accepts valid, rejects bad entries", () => {
  assertEquals(isDeviceArray([]), true)
  assertEquals(
    isDeviceArray([
      { deviceID: "X-X-X", name: "n" },
    ]),
    true,
  )
  assertEquals(isDeviceArray([{ deviceID: "X" }]), false) // missing name
  assertEquals(isDeviceArray([{ name: "n" }]), false) // missing deviceID
  assertEquals(isDeviceArray([{ deviceID: 42, name: "n" }]), false)
})
