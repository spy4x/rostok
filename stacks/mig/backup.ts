import { BackupConfig } from "@scripts/backup"

const backupConfig: BackupConfig = {
  name: "mig",
  sourcePaths: "default",
  // The mig container runs as uid 70 (unbound) and creates the JSON file
  // owned by that user. Override ownership on backup so restic can read
  // the file under the spy4x backup user.
  pathsToChangeOwnership: "default",
  // Stop the container so the atomic-write rename completes before we
  // snapshot the directory. Window is sub-second.
  containers: {
    stop: "default",
  },
}

export default backupConfig
