import { BackupConfig } from "@scripts/backup"

const backupConfig: BackupConfig = {
  name: "mig",
  sourcePaths: "default",
  // compose.yml runs the mig container as ${PUID:-1000}:${PGID:-1000},
  // not the image's built-in non-root user, but PUID/PGID can still
  // differ from the OS user running this backup script. Override
  // ownership on backup so restic can read the file under that user
  // regardless.
  pathsToChangeOwnership: "default",
  // Stop the container so the atomic-write rename completes before we
  // snapshot the directory. Window is sub-second.
  containers: {
    stop: "default",
  },
}

export default backupConfig
