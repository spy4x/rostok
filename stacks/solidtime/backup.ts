import { BackupConfig, VOLUMES_PATH } from "@scripts/backup"

const backupConfig: BackupConfig = {
  name: "solidtime",
  // The database and the storage folder, which holds uploads and the OAuth key pair.
  sourcePaths: [`${VOLUMES_PATH}/solidtime`],
  containers: {
    stop: "default",
  },
}

export default backupConfig
