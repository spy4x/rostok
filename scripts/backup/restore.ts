// Restore script for recovering service data from backups
// Usage: deno task backup:restore <service-name> [snapshot-id]
// Example: deno task backup:restore gatus
// Example: deno task backup:restore gatus a1b2c3d4
//
// Run it the way the nightly backup runs (same user, same env files): restic
// can only give the files back their owners when it runs as root.

import { dirname, join } from "@std/path"
import { absPath, error, log } from "../+lib.ts"
import { getEnvVar, PATH_APPS, USER } from "./src/+lib.ts"
import { BackupConfigProcessor } from "./src/config.ts"
import { BackupOperations } from "./src/operations.ts"
import { applyRestore, planRestore } from "./src/restore.ts"
import { type BackupConfigState, BackupStatus } from "./src/types.ts"

interface RestoreOptions {
  serviceName: string
  snapshotId?: string
}

interface Snapshot {
  id: string
  fullId: string
  time: string
  paths: string[]
}

class RestoreRunner {
  private backupsPassword = getEnvVar("BACKUPS_PASSWORD")
  // The same folder the backup runner writes its repositories to.
  private backupsBasePath = absPath(getEnvVar("PATH_BACKUPS"), USER)
  private operations = new BackupOperations(this.backupsPassword)

  async run(options: RestoreOptions): Promise<void> {
    log(`Starting restore for service: ${options.serviceName}`)

    const configs = await BackupConfigProcessor.loadConfigurations(
      absPath(`${PATH_APPS}/stacks`, USER),
      absPath(`${PATH_APPS}/configs/backup`, USER),
    )
    const config = configs.find((c) => c.name === options.serviceName)
    if (!config) {
      const names = configs.map((c) =>
        `  - ${c.name}${c.destName ? ` (backup: ${c.destName})` : ""}`
      )
      throw new Error(
        `Service "${options.serviceName}" not found in backup configs. Available services:\n${
          names.join("\n")
        }`,
      )
    }

    // Resolve "default" without requiring the folders to exist: a restore is
    // often run exactly because they are gone.
    if (!BackupConfigProcessor.normalize(config)) {
      throw new Error(config.error ?? `Backup config of ${config.name} is not valid`)
    }
    const sourcePaths = (config.sourcePaths as string[]).map((path) =>
      absPath(path, USER).replace(/(?<=.)\/+$/, "")
    )

    const repoPath = `${this.backupsBasePath}/${config.destName || config.name}`
    if (!await isDirectory(repoPath)) {
      throw new Error(`Backup repository not found at: ${repoPath}`)
    }

    const snapshots = await this.listSnapshots(repoPath)
    if (snapshots.length === 0) throw new Error("No snapshots found in repository")
    const snapshot = options.snapshotId
      ? snapshots.find((s) => s.fullId.startsWith(options.snapshotId!))
      : snapshots[0]
    if (!snapshot) throw new Error(`Snapshot "${options.snapshotId}" not found`)
    log(`Selected snapshot: ${snapshot.id} (${snapshot.time})`)

    // Fails here, before anything is stopped, when the snapshot does not hold
    // the folders this config names.
    const matches = planRestore(sourcePaths, snapshot.paths)

    const confirm = prompt(
      `\nThis will restore ${config.name} from snapshot ${snapshot.id}:\n${
        matches.map(({ snapshotPath, to }) =>
          snapshotPath === to ? `  ${to}` : `  ${to}\n    from the snapshot's ${snapshotPath}`
        ).join("\n")
      }\nData already there is kept beside it as <folder>.backup-<time>.\nType 'yes' to continue: `,
    )
    if (confirm?.toLowerCase() !== "yes") {
      log("Restore cancelled")
      return
    }

    // Ctrl-C also reaches restic, which then fails; staying alive lets the
    // `finally` below start the containers again.
    const onInterrupt = () => log("Interrupted, putting things back...")
    Deno.addSignalListener("SIGINT", onInterrupt)

    const restoreRoots: string[] = []
    try {
      await this.operations.manageContainers(config, "stop")
      this.throwIfFailed(config)

      // Each folder is unpacked next to its destination: the move into place
      // is then a rename on one disk, and the system temp folder, often
      // RAM-backed, never has to hold a volume.
      const moves = []
      for (const { snapshotPath, to } of matches) {
        await Deno.mkdir(dirname(to), { recursive: true })
        const root = await Deno.makeTempDir({ dir: dirname(to), prefix: ".restore-" })
        restoreRoots.push(root)
        log(`Unpacking ${snapshotPath} into: ${root}`)
        await this.restoreSnapshot(repoPath, snapshot.id, snapshotPath, root)
        moves.push({ from: join(root, snapshotPath), to })
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, "-")
      const keptOldData = await applyRestore(moves, stamp)
      for (const path of keptOldData) log(`Previous data kept at: ${path}`)

      await this.operations.changeOwnership(config)
      this.throwIfFailed(config)
    } finally {
      // Containers first: a failed cleanup must not leave the service down.
      // A failed stop must not hide a failed start either.
      config.status = BackupStatus.IN_PROGRESS
      await this.operations.manageContainers(config, "start")
      for (const root of restoreRoots) {
        try {
          await Deno.remove(root, { recursive: true })
        } catch (err) {
          error(`Could not remove ${root}, delete it by hand: ${err}`)
        }
      }
      Deno.removeSignalListener("SIGINT", onInterrupt)
    }
    this.throwIfFailed(config)

    log("✅ Restore completed successfully!")
    log("Check that the service runs and works, then delete the .backup-<time> folders.")
  }

  private throwIfFailed(config: BackupConfigState): void {
    if (config.status === BackupStatus.ERROR) {
      throw new Error(config.error ?? `Restore of ${config.name} failed`)
    }
  }

  private async listSnapshots(repoPath: string): Promise<Snapshot[]> {
    const output = await new Deno.Command("restic", {
      args: ["-r", repoPath, "snapshots", "--json"],
      env: { RESTIC_PASSWORD: this.backupsPassword },
      stdout: "piped",
      stderr: "piped",
    }).output()
    if (!output.success) {
      throw new Error(`Failed to list snapshots: ${new TextDecoder().decode(output.stderr)}`)
    }

    const snapshots: Array<
      { id: string; short_id: string; time: string; paths: string[] }
    > = JSON.parse(
      new TextDecoder().decode(output.stdout),
    )
    return snapshots
      .reverse() // Most recent first
      .map((s) => ({ id: s.short_id, fullId: s.id, time: s.time, paths: s.paths }))
  }

  private async restoreSnapshot(
    repoPath: string,
    snapshotId: string,
    snapshotPath: string,
    targetPath: string,
  ): Promise<void> {
    const output = await new Deno.Command("restic", {
      args: [
        "-r",
        repoPath,
        "restore",
        snapshotId,
        "--target",
        targetPath,
        "--include",
        snapshotPath,
      ],
      env: { RESTIC_PASSWORD: this.backupsPassword },
      stdout: "inherit",
      stderr: "inherit",
    }).output()
    if (!output.success) throw new Error(`Failed to unpack ${snapshotPath}; no data was changed`)
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory
  } catch {
    return false
  }
}

const args = Deno.args
if (args.length < 1) {
  console.log("Usage: deno task backup:restore <service-name> [snapshot-id]")
  console.log("Example: deno task backup:restore gatus")
  console.log("Example: deno task backup:restore gatus a1b2c3d4")
  console.log("")
  console.log("The service name should match the 'name' field in backup config.")
  Deno.exit(1)
}

try {
  await new RestoreRunner().run({ serviceName: args[0], snapshotId: args[1] })
} catch (err) {
  error(err instanceof Error ? err.message : String(err))
  Deno.exit(1)
}
