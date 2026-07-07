import { assertEquals, assertStringIncludes } from "@std/assert"
import {
  extractVolumePaths,
  generateDeployScript,
  generateVolumeCreationScript,
  parseDeployResults,
  printDeploySummary,
  type StackConfig,
} from "./src/+lib.ts"

Deno.test({
  name: "parseDeployResults extracts success from markers",
  fn() {
    const stacks: StackConfig[] = [{ name: "traefik" }, { name: "gatus" }]
    const output = [
      "DEPLOY_START:traefik:traefik",
      "some output",
      "DEPLOY_SUCCESS:traefik:traefik",
      "DEPLOY_START:gatus:gatus",
      "more output",
      "DEPLOY_FAILED:gatus:gatus",
      "error detail",
    ].join("\n")

    const results = parseDeployResults(output, stacks)
    assertEquals(results.length, 2)
    assertEquals(results[0].name, "traefik")
    assertEquals(results[0].success, true)
    assertEquals(results[1].name, "gatus")
    assertEquals(results[1].success, false)
    assertStringIncludes(results[1].error || "", "more output")
  },
})

Deno.test({
  name: "parseDeployResults returns false for missing markers",
  fn() {
    const stacks: StackConfig[] = [{ name: "missing" }]
    const output = "no markers here"
    const results = parseDeployResults(output, stacks)
    assertEquals(results[0].success, false)
  },
})

Deno.test({
  name: "parseDeployResults handles deployAs alias",
  fn() {
    const stacks: StackConfig[] = [{ name: "app", deployAs: "my-app" }]
    const output = [
      "DEPLOY_START:app:my-app",
      "DEPLOY_SUCCESS:app:my-app",
    ].join("\n")
    const results = parseDeployResults(output, stacks)
    assertEquals(results[0].success, true)
    assertEquals(results[0].deployAs, "my-app")
  },
})

Deno.test({
  name: "generateDeployScript produces docker compose commands",
  fn() {
    const stacks: StackConfig[] = [{ name: "test-stack" }]
    const script = generateDeployScript(stacks, "/apps", new Set())
    assertStringIncludes(script, "DEPLOY_START:test-stack:test-stack")
    assertStringIncludes(script, "docker compose -p test-stack")
    assertStringIncludes(script, "f stacks/test-stack/compose.yml")
  },
})

Deno.test({
  name: "generateDeployScript adds restart when stack needs restart",
  fn() {
    const stacks: StackConfig[] = [{ name: "traefik" }]
    const script = generateDeployScript(stacks, "/apps", new Set(["traefik"]))
    assertStringIncludes(script, "RESTARTING:traefik:traefik")
    assertStringIncludes(script, "docker compose -p traefik -f stacks/traefik/compose.yml restart")
  },
})

Deno.test({
  name: "extractVolumePaths finds VOLUMES_PATH references",
  fn() {
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
    assertEquals(paths.length, 1)
    assertEquals(paths[0], "/volumes/myapp/data")
  },
})

Deno.test({
  name: "extractVolumePaths handles multiple compose files",
  fn() {
    const composeContents = [
      `- \${VOLUMES_PATH}/app1/data:/data:z`,
      `- \${VOLUMES_PATH}/app2/logs:/logs:z`,
    ]
    const paths = extractVolumePaths(composeContents, { VOLUMES_PATH: "/vol" })
    assertEquals(paths.length, 2)
    assertEquals(paths.includes("/vol/app1/data"), true)
    assertEquals(paths.includes("/vol/app2/logs"), true)
  },
})

Deno.test({
  name: "generateVolumeCreationScript creates mkdir and chown commands",
  fn() {
    const paths = ["/volumes/app/data", "/volumes/app/logs"]
    const script = generateVolumeCreationScript(paths, "testuser")
    assertStringIncludes(script, 'mkdir -p "/volumes/app/data"')
    assertStringIncludes(script, 'mkdir -p "/volumes/app/logs"')
    assertStringIncludes(script, "chown -R testuser:testuser")
  },
})

Deno.test({
  name: "printDeploySummary produces output without errors",
  fn() {
    const results = [
      { name: "ok", deployAs: "ok", success: true },
      { name: "fail", deployAs: "fail", success: false, error: "something broke" },
    ]
    // Just verify it runs without throwing
    printDeploySummary(results as Parameters<typeof printDeploySummary>[0])
  },
})
