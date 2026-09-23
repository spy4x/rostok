import { assertEquals, assertStringIncludes } from "@std/assert"
import { extractVolumePaths, generateVolumeCreationScript } from "./volumes.ts"

Deno.test("extractVolumePaths finds VOLUMES_PATH references", () => {
  const composeContents = [
    `
services:
  app:
    volumes:
      - \${VOLUMES_PATH}/myapp/data:/data:z
`,
  ]
  const env = { VOLUMES_PATH: "/volumes" }
  const paths = extractVolumePaths(composeContents, env)
  assertEquals(paths, ["/volumes/myapp/data"])
})

Deno.test("extractVolumePaths handles multiple compose files", () => {
  const composeContents = [
    `- \${VOLUMES_PATH}/app1/data:/data:z`,
    `- \${VOLUMES_PATH}/app2/logs:/logs:z`,
  ]
  const paths = extractVolumePaths(composeContents, { VOLUMES_PATH: "/vol" })
  assertEquals(paths.includes("/vol/app1/data"), true)
  assertEquals(paths.includes("/vol/app2/logs"), true)
})

Deno.test("generateVolumeCreationScript chowns to PUID:PGID, not a user name", () => {
  const script = generateVolumeCreationScript(["/volumes/app/data"], "1000", "1000", "root")
  assertStringIncludes(script, 'mkdir -p "/volumes/app/data"')
  assertStringIncludes(script, 'chown -R 1000:1000 "/volumes/app/data"')
})

Deno.test("generateVolumeCreationScript never hides a failure", () => {
  const script = generateVolumeCreationScript(["/volumes/app/data"], "1000", "1000", "root")
  assertEquals(script.includes("|| true"), false)
  assertEquals(script.includes("2>/dev/null"), false)
})

Deno.test("generateVolumeCreationScript: no sudo prefix for the root user", () => {
  const script = generateVolumeCreationScript(["/volumes/app"], "1000", "1000", "root")
  assertEquals(script.includes("sudo"), false)
})

Deno.test("generateVolumeCreationScript: prefixes mkdir and chown with sudo -n for a non-root user", () => {
  const script = generateVolumeCreationScript(["/volumes/app"], "1000", "1000", "deploy")
  assertStringIncludes(script, 'sudo -n mkdir -p "/volumes/app"')
  assertStringIncludes(script, 'sudo -n chown -R 1000:1000 "/volumes/app"')
})

Deno.test("generateVolumeCreationScript joins multiple paths with &&", () => {
  const script = generateVolumeCreationScript(
    ["/volumes/a", "/volumes/b"],
    "1000",
    "1000",
    "root",
  )
  assertEquals(
    script,
    'mkdir -p "/volumes/a" && chown -R 1000:1000 "/volumes/a" && mkdir -p "/volumes/b" && chown -R 1000:1000 "/volumes/b"',
  )
})
