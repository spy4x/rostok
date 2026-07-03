import { BackupConfig, VOLUMES_PATH } from "@scripts/backup"

const backupConfig: BackupConfig = {
  name: "victoria-metrics",
  sourcePaths: [
    `${VOLUMES_PATH}/victoria-metrics`,
    `${VOLUMES_PATH}/victoria-logs`,
  ],
  containers: {
    stop: [
      "hl-victoria-metrics",
      "hl-vmagent",
      "hl-victoria-logs",
      "hl-promtail-vm",
      "hl-grafana-vm",
    ],
  },
}

export default backupConfig
