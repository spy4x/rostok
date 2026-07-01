import { BackupConfig } from "@scripts/backup"

const backupConfig: BackupConfig = {
  name: "bulwark",
  sourcePaths: [
    "${VOLUMES_PATH}/bulwark/settings",
    "${VOLUMES_PATH}/bulwark/admin",
  ],
  containers: {
    stop: "default",
  },
}

export default backupConfig
