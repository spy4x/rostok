// Tests for stacks/syncthing/before.deploy.ts pure helpers.
// (No shell interaction — those run via the deploy script.)

import { assertEquals, assertThrows } from "@std/assert"

import {
  collectHostPaths,
  ConfigError,
  expandHome,
  type Mount,
  resolveFolderHostPath,
  validateConfig,
} from "./before.deploy.ts"

const USER = "spy4x"

Deno.test("validateConfig: minimal valid config", () => {
  const cfg = validateConfig({
    data_dir: "~/appdata/syncthing",
  })
  assertEquals(cfg.data_dir, "~/appdata/syncthing")
})

Deno.test("validateConfig: full valid config (with versioning, paused, addresses)", () => {
  const cfg = validateConfig({
    data_dir: "~/ssd/syncthing",
    mounts: [
      { host: "~/ssd/sync", container: "/sync" },
      { host: "~/hdd", container: "/hdd" },
    ],
    folders: [
      {
        id: "archive",
        path: "/sync/archive",
        type: "sendreceive",
        paused: false,
        versioning: {
          type: "trashcan",
          params: { cleanoutDays: "180", keep: "5" },
        },
        devices: ["spy4x-home", "spy4x-offsite"],
      },
      {
        id: "backups",
        path: "/hdd/sync/backups",
        devices: ["spy4x-home"],
      },
    ],
    devices: [
      { id: "AAA-BBB", name: "spy4x-home" },
      { id: "CCC-DDD", name: "spy4x-offsite", addresses: ["tcp://1.2.3.4:22000"], untrusted: true },
    ],
  })
  assertEquals(cfg.folders?.length, 2)
  assertEquals((cfg.folders![0] as { paused?: boolean }).paused, false)
})

Deno.test("validateConfig: missing data_dir", () => {
  assertThrows(
    () => validateConfig({}),
    ConfigError,
    "data_dir",
  )
})

Deno.test("validateConfig: folder references unknown device — collect ALL errors", () => {
  try {
    validateConfig({
      data_dir: "~/appdata",
      devices: [{ id: "AAA-AAA", name: "declared" }],
      folders: [
        { id: "f1", path: "/sync/f1", devices: ["declared"] },
        { id: "f2", path: "/sync/f2", devices: ["undeclared"] },
        { id: "f3", path: "/sync/f3", devices: ["also-undeclared"] },
      ],
    })
    throw new Error("should have thrown")
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err
    // Both unknown device references should be collected, not just the first
    assertEquals(err.errors.length, 2)
    assertEquals(
      err.errors.some((e) => e.includes("undeclared") && e.includes("f2")),
      true,
    )
    assertEquals(
      err.errors.some((e) => e.includes("also-undeclared") && e.includes("f3")),
      true,
    )
  }
})

Deno.test("validateConfig: duplicate device names", () => {
  assertThrows(
    () =>
      validateConfig({
        data_dir: "~/appdata",
        devices: [
          { id: "AAA", name: "dup" },
          { id: "BBB", name: "dup" },
        ],
      }),
    ConfigError,
    "dup",
  )
})

Deno.test("validateConfig: duplicate folder ids", () => {
  assertThrows(
    () =>
      validateConfig({
        data_dir: "~/appdata",
        folders: [
          { id: "x", path: "/sync/x", devices: [] },
          { id: "x", path: "/sync/y", devices: [] },
        ],
      }),
    ConfigError,
    "duplicated",
  )
})

Deno.test("validateConfig: mount container must be absolute", () => {
  assertThrows(
    () =>
      validateConfig({
        data_dir: "~/appdata",
        mounts: [{ host: "~/x", container: "x" }],
      }),
    ConfigError,
    "absolute",
  )
})

Deno.test("validateConfig: missing folder path", () => {
  assertThrows(
    () =>
      validateConfig({
        data_dir: "~/appdata",
        folders: [{ id: "f", devices: [] }],
      }),
    ConfigError,
    "absolute",
  )
})

Deno.test("validateConfig: missing folder id", () => {
  assertThrows(
    () =>
      validateConfig({
        data_dir: "~/appdata",
        folders: [{ path: "/sync/x", devices: [] }],
      }),
    ConfigError,
    "folders[0].id",
  )
})

Deno.test("expandHome: ~/", () => {
  assertEquals(expandHome("~/foo", USER), `/home/${USER}/foo`)
  assertEquals(expandHome("~/", USER), `/home/${USER}/`)
})

Deno.test("expandHome: absolute path passthrough", () => {
  assertEquals(expandHome("/var/data", USER), "/var/data")
})

Deno.test("resolveFolderHostPath: matches longest mount prefix", () => {
  const mounts: Mount[] = [
    { host: "~/ssd/sync", container: "/sync" },
    { host: "~/hdd", container: "/hdd" },
  ]
  assertEquals(
    resolveFolderHostPath("/sync/archive", mounts, USER),
    `/home/${USER}/ssd/sync/archive`,
  )
  assertEquals(
    resolveFolderHostPath("/hdd/sync/backups", mounts, USER),
    `/home/${USER}/hdd/sync/backups`,
  )
})

Deno.test("resolveFolderHostPath: throws when no mount matches", () => {
  const mounts: Mount[] = [
    { host: "~/ssd/sync", container: "/sync" },
  ]
  assertThrows(
    () => resolveFolderHostPath("/elsewhere/x", mounts, USER),
    Error,
    "not under any declared mount",
  )
})

Deno.test("resolveFolderHostPath: exact mount path", () => {
  // If folder path equals the mount root exactly, host is just the mount host
  const mounts: Mount[] = [
    { host: "~/ssd/sync", container: "/sync" },
  ]
  assertEquals(
    resolveFolderHostPath("/sync", mounts, USER),
    `/home/${USER}/ssd/sync`,
  )
})

Deno.test("collectHostPaths: includes data_dir, mount roots, folder subdirs", () => {
  const config = {
    data_dir: "~/appdata",
    mounts: [
      { host: "~/ssd/sync", container: "/sync" },
      { host: "~/hdd", container: "/hdd" },
    ],
    folders: [
      { id: "a", path: "/sync/archive", devices: [] },
      { id: "b", path: "/hdd/backups", devices: [] },
    ],
  }
  const paths = collectHostPaths(config as never, USER)
  assertEquals(
    new Set(paths),
    new Set([
      `/home/${USER}/appdata`,
      `/home/${USER}/ssd/sync`,
      `/home/${USER}/hdd`,
      `/home/${USER}/ssd/sync/archive`,
      `/home/${USER}/hdd/backups`,
    ]),
  )
})
