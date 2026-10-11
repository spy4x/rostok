import { BackupConfig } from "@scripts/backup"

// The OAuth store (Deno KV, oauth.kv): the grants that keep connectors signed
// in. The container is stopped so the SQLite file and its write-ahead log are
// copied in one consistent state.
//
// No pathsToChangeOwnership: the volume belongs to the container's PUID:PGID,
// and where that is not the server user, a chown to the server user would lock
// the app out of its own store.
const backupConfig: BackupConfig = {
  name: "caldav-mcp",
  sourcePaths: "default",
  containers: {
    stop: "default",
  },
}

export default backupConfig
