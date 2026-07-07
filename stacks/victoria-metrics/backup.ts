import { BackupConfig, VOLUMES_PATH } from "@scripts/backup"

const backupConfig: BackupConfig = {
  name: "victoria-metrics",
  sourcePaths: [
    `${VOLUMES_PATH}/victoria-metrics`,
    `${VOLUMES_PATH}/victoria-logs`,
  ],
  containers: {
    stop: "default",
  },
}

export default backupConfig
