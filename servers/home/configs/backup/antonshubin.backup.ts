import { BackupConfig } from "@scripts/backup"

const backupConfig: BackupConfig = {
  name: "antonshubin",
  sourcePaths: [
    "${BASE_PATH}/apps/anton/antonshubin.com/data",
  ],
  containers: {
    stop: ["antonshubincom-web"],
  },
}

export default backupConfig
