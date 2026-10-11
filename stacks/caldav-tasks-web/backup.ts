import { BackupConfig } from "@scripts/backup"

// push.json: the browsers subscribed to reminder notifications.
//
// The container is not stopped: the file is small and written only when a
// browser subscribes or a reminder goes out, so a snapshot taken mid-write is
// unlikely, and the previous night's snapshot would still be good. Stopping it
// would take the app down every night.
//
// No pathsToChangeOwnership: the volume belongs to the container's PUID:PGID,
// and where that is not the server user, a chown to the server user would stop
// the app from writing the file.
const backupConfig: BackupConfig = {
  name: "caldav-tasks-web",
  sourcePaths: "default",
}

export default backupConfig
