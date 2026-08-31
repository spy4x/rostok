import { basename, dirname, isAbsolute, join, normalize } from "@std/path"
import type { BackupConfig } from "@scripts/backup"

const unsafeDataPaths = new Set([
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/opt",
  "/root",
  "/run",
  "/srv",
  "/tmp",
  "/usr",
  "/var",
])

export function resolveHomeAssistantDataPath(path: string): string {
  const normalizedPath = normalize(path)

  if (!isAbsolute(normalizedPath)) {
    throw new Error("HOME_ASSISTANT_DATA_PATH must be absolute")
  }

  if (unsafeDataPaths.has(normalizedPath)) {
    throw new Error("HOME_ASSISTANT_DATA_PATH must point to a dedicated subdirectory")
  }

  if (basename(normalizedPath) !== "home-assistant") {
    throw new Error("HOME_ASSISTANT_DATA_PATH must end with /home-assistant")
  }

  return normalizedPath
}

export async function ensureHomeAssistantDataPath(path: string): Promise<string> {
  const dataPath = resolveHomeAssistantDataPath(path)
  await rejectGitTree(dataPath)

  try {
    const stat = await Deno.lstat(dataPath)
    if (stat.isSymlink) throw new Error("HOME_ASSISTANT_DATA_PATH cannot be a symlink")
    if (!stat.isDirectory) throw new Error("HOME_ASSISTANT_DATA_PATH must be a directory")
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error
    await Deno.mkdir(dataPath, { recursive: true, mode: 0o700 })
  }

  return await Deno.realPath(dataPath)
}

export async function validateZigbeeDevicePath(
  path: string,
  allowedRoot = "/dev/serial/by-id",
): Promise<string> {
  const normalizedPath = resolveZigbeeDevicePath(path, allowedRoot)

  const linkStat = await Deno.lstat(normalizedPath)
  if (!linkStat.isSymlink) throw new Error("ZIGBEE_DEVICE_PATH must be a stable symlink")

  const targetPath = await Deno.realPath(normalizedPath)
  const targetStat = await Deno.stat(targetPath)
  if (!targetStat.isCharDevice) throw new Error("ZIGBEE_DEVICE_PATH must target a character device")

  return normalizedPath
}

export function resolveZigbeeDevicePath(
  path: string,
  allowedRoot = "/dev/serial/by-id",
): string {
  const normalizedPath = normalize(path)
  const normalizedRoot = normalize(allowedRoot)
  if (dirname(normalizedPath) !== normalizedRoot) {
    throw new Error("ZIGBEE_DEVICE_PATH must be directly under /dev/serial/by-id")
  }
  return normalizedPath
}

async function rejectGitTree(path: string): Promise<void> {
  let current = path
  while (true) {
    try {
      await Deno.lstat(join(current, ".git"))
      throw new Error("HOME_ASSISTANT_DATA_PATH cannot be inside a Git worktree")
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error
    }

    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

export function createHomeAssistantBackupConfig(localDataPath?: string): BackupConfig {
  if (!localDataPath) {
    return {
      name: "home-assistant",
      sourcePaths: "default",
      pathsToChangeOwnership: "default",
      containers: { stop: "default" },
    }
  }

  const dataPath = resolveHomeAssistantDataPath(localDataPath)
  return {
    name: "home-assistant",
    sourcePaths: [dataPath],
    pathsToChangeOwnership: [],
    containers: { stop: ["hl-home-assistant-local"] },
  }
}
