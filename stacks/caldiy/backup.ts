import { BackupConfig, VOLUMES_PATH } from "@scripts/backup"

const backupConfig: BackupConfig = {
  name: "caldiy",
  sourcePaths: [
    `${VOLUMES_PATH}/caldiy/postgres`,
    `${VOLUMES_PATH}/caldiy/redis`,
  ],
  containers: {
    stop: ["hl-caldiy", "hl-caldiy-db", "hl-caldiy-redis"],
  },
}

export default backupConfig
