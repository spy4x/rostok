import { BackupConfig, VOLUMES_PATH } from "@scripts/backup"

const backupConfig: BackupConfig = {
  name: "victoria-metrics",
  sourcePaths: [
    `${VOLUMES_PATH}/victoria-metrics`,
    `${VOLUMES_PATH}/victoria-logs`,
    `${VOLUMES_PATH}/grafana`,
  ],
  containers: {
    stop: "default",
  },
}

export default backupConfig
