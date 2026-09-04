import { BackupConfig, VOLUMES_PATH } from "@scripts/backup"

const backupConfig: BackupConfig = {
  name: "deepseek-harness",
  // Host-level install puts DSH_HOME at ~/.local/share/dsh, NOT under
  // VOLUMES_PATH. The default (`${VOLUMES_PATH}/deepseek-harness`)
  // resolves to a directory that exists only if the legacy container
  // form is in use — empty when running host-level. Include it
  // anyway so the backup script doesn't error out on hosts that
  // still mount the Docker volume (e.g. during the migration window).
  sourcePaths: [`${VOLUMES_PATH}/deepseek-harness`],
  // Host-level: no container to stop. An empty array disables the
  // docker-compose freeze step entirely.
  containers: {
    stop: [],
  },
}

export default backupConfig
