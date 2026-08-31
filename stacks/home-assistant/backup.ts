import { createHomeAssistantBackupConfig } from "./+lib.ts"

const backupConfig = createHomeAssistantBackupConfig(Deno.env.get("HOME_ASSISTANT_DATA_PATH"))

export default backupConfig
