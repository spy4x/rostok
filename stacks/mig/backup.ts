import { BackupConfig } from "@scripts/backup"

const backupConfig: BackupConfig = {
  name: "mig",
  sourcePaths: "default",
  // compose.yml runs the mig container as ${PUID:-1000}:${PGID:-1000},
  // not the image's built-in non-root user. `changeOwnership`
  // (scripts/backup/src/operations.ts:179-185) always runs
  // `sudo chown -R $USER:$USER` on this path before backup and never
  // restores it afterward, so the OS user running this backup script
  // must be the same uid:gid as PUID:PGID — otherwise the first backup
  // leaves ${VOLUMES_PATH}/mig owned by a different user and locks the
  // mig container out of /data on its next write.
  pathsToChangeOwnership: "default",
  // Stop the container so the atomic-write rename completes before we
  // snapshot the directory. Window is sub-second.
  containers: {
    stop: "default",
  },
}

export default backupConfig
