import { BackupConfig, SERVER_NAME } from "@scripts/backup"

const backupConfig: BackupConfig = {
  name: "healthchecks",
  destName: `healthchecks-${SERVER_NAME}`, // Suffix added because healthchecks is shared across servers
  sourcePaths: "default",
  containers: {
    stop: ["hl-healthchecks"],
  },
}

export default backupConfig
