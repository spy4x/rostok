// Guards the volume reminder notifications need in compose.yml (spy4x/caldav-tasks-web#60).

import { assertEquals } from "@std/assert"
import { parse } from "yaml"

interface Compose {
  services: Record<string, { user: string; volumes: string[] }>
}

const compose = parse(
  await Deno.readTextFile(new URL(`./compose.yml`, import.meta.url)),
) as Compose

const service = compose.services[`caldav-tasks-web`]

Deno.test("caldav-tasks-web: the push subscriptions live on a volume at /data", () => {
  // Without it the image's own /data is writable, so notifications seem to work and every
  // deploy forgets the subscribed browsers.
  assertEquals(service.volumes, [`\${VOLUMES_PATH}/caldav-tasks-web:/data:z`])
})

Deno.test("caldav-tasks-web: the container runs as PUID:PGID, the owner of /data", () => {
  assertEquals(service.user, `\${PUID:-1000}:\${PGID:-1000}`)
})
