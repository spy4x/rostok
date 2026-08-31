import { fromFileUrl } from "@std/path"
import {
  ensureHomeAssistantDataPath,
  resolveHomeAssistantDataPath,
  resolveZigbeeDevicePath,
  validateZigbeeDevicePath,
} from "./+lib.ts"

const actions: Record<string, string[]> = {
  up: ["up", "-d"],
  down: ["down"],
  stop: ["stop"],
  config: ["config"],
}

const action = Deno.args[0]
if (!action || !actions[action]) {
  throw new Error(`Expected one action: ${Object.keys(actions).join(", ")}`)
}

const configuredDataPath = getRequiredEnv("HOME_ASSISTANT_DATA_PATH")
const configuredDevicePath = getRequiredEnv("ZIGBEE_DEVICE_PATH")
const dataPath = action === "up"
  ? await ensureHomeAssistantDataPath(configuredDataPath)
  : resolveHomeAssistantDataPath(configuredDataPath)
const devicePath = action === "up"
  ? await validateZigbeeDevicePath(configuredDevicePath)
  : resolveZigbeeDevicePath(configuredDevicePath)
const composePath = fromFileUrl(new URL("./compose.local.yml", import.meta.url))

const result = await new Deno.Command("docker", {
  args: ["compose", "-f", composePath, ...actions[action]],
  env: {
    ...Deno.env.toObject(),
    HOME_ASSISTANT_DATA_PATH: dataPath,
    ZIGBEE_DEVICE_PATH: devicePath,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).output()

if (!result.success) Deno.exit(result.code)

function getRequiredEnv(key: string): string {
  const value = Deno.env.get(key)
  if (!value) throw new Error(`Missing environment variable: ${key}`)
  return value
}
