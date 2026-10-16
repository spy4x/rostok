import { BackupConfig, VOLUMES_PATH } from "@scripts/backup"

// Nothing is stopped, so pipelines keep running through the backup. The live database is left
// out: woodpecker-db writes a consistent copy to backup/ every 15 minutes, and puts it back in
// place when the database is missing after a restore. Build logs are one file per step, appended
// while a step runs, so a copy taken mid-step only misses that step's last lines.
const backupConfig: BackupConfig = {
  name: "woodpecker-server",
  sourcePaths: [
    `${VOLUMES_PATH}/woodpecker-server/backup`,
    `${VOLUMES_PATH}/woodpecker-server/logs`,
  ],
}

export default backupConfig
