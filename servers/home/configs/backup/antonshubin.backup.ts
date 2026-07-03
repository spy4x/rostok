import { BackupConfig, PATH_APPS } from "@scripts/backup"

// PATH_APPS = ${BASE_PATH}/apps/anton/home
// antonshubin.com is sibling of home/
const ANTONSHUBIN_DATA = PATH_APPS.replace("/home", "/antonshubin.com/data")

const backupConfig: BackupConfig = {
  name: "antonshubin",
  sourcePaths: [
    ANTONSHUBIN_DATA,
  ],
  containers: {
    stop: ["antonshubincom-web"],
  },
}

export default backupConfig
