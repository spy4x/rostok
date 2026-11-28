import { BackupConfig, VOLUMES_PATH } from "@scripts/backup"

// Only the database: `cache/` holds thumbnails and archive downloads the app rebuilds, and the
// mounted folders under /srv are backed up by whatever owns them.
const backupConfig: BackupConfig = {
  name: "quantum-filebrowser",
  sourcePaths: [`${VOLUMES_PATH}/quantum-filebrowser/data`],
  containers: {
    stop: "default",
  },
}

export default backupConfig
