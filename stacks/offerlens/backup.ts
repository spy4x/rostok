import { BackupConfig } from "@scripts/backup"

const backupConfig: BackupConfig = {
  name: "offerlens",
  sourcePaths: "default",
  containers: {
    stop: "default",
  },
}

export default backupConfig
