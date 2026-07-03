import { BackupConfig } from "@scripts/backup"

const backupConfig: BackupConfig = {
  name: "victoria-metrics",
  sourcePaths: "default",
  containers: {
    stop: "default",
  },
}

export default backupConfig
