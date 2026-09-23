import { assertEquals, assertStringIncludes } from "@std/assert"
import {
  generateDeployScript,
  parseDeployResults,
  printDeploySummary,
  type StackConfig,
} from "./deploy-script.ts"

Deno.test("parseDeployResults extracts success from markers", () => {
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
})

Deno.test("parseDeployResults returns false for missing markers", () => {
  const stacks: StackConfig[] = [{ name: "missing" }]
  const output = "no markers here"
  const results = parseDeployResults(output, stacks)
  assertEquals(results[0].success, false)
})

Deno.test("parseDeployResults handles deployAs alias", () => {
  const stacks: StackConfig[] = [{ name: "app", deployAs: "my-app" }]
  const output = [
    "DEPLOY_START:app:my-app",
    "DEPLOY_SUCCESS:app:my-app",
  ].join("\n")
  const results = parseDeployResults(output, stacks)
  assertEquals(results[0].success, true)
  assertEquals(results[0].deployAs, "my-app")
})

Deno.test("generateDeployScript produces docker compose commands", () => {
  const stacks: StackConfig[] = [{ name: "test-stack" }]
  const script = generateDeployScript(stacks, "/apps", new Set())
  assertStringIncludes(script, "DEPLOY_START:test-stack:test-stack")
  assertStringIncludes(script, "docker compose -p test-stack")
  assertStringIncludes(script, "f stacks/test-stack/compose.yml")
})

Deno.test("generateDeployScript includes stale-container cleanup before up -d", () => {
  // Prevents "name already in use" when a previous deployment used a
  // different compose project name (e.g. manual `docker compose up` that
  // picked up `name: ${PROJECT}` from compose.yml, producing project=hl,
  // vs deploy's -p ${stack} producing project=${stack}).
  const stacks: StackConfig[] = [{ name: "healthchecks" }]
  const script = generateDeployScript(stacks, "/apps", new Set())
  assertStringIncludes(script, 'docker ps -a --filter "name=hl-healthchecks"')
  assertStringIncludes(script, "com.docker.compose.project")
  assertStringIncludes(script, "docker rm -f")
  assertStringIncludes(script, '"$proj" != "healthchecks"')
})

Deno.test("generateDeployScript adds restart when stack needs restart", () => {
  const stacks: StackConfig[] = [{ name: "traefik" }]
  const script = generateDeployScript(stacks, "/apps", new Set(["traefik"]))
  assertStringIncludes(script, "RESTARTING:traefik:traefik")
  assertStringIncludes(script, 'docker compose -p traefik "$@" restart')
})

Deno.test("printDeploySummary produces output without errors", () => {
  const results = [
    { name: "ok", deployAs: "ok", success: true },
    { name: "fail", deployAs: "fail", success: false, error: "something broke" },
  ]
  // Just verify it runs without throwing
  printDeploySummary(results as Parameters<typeof printDeploySummary>[0])
})

Deno.test("generateDeployScript passes compose files as quoted positional args", () => {
  // The remote login shell is zsh, which does not word-split unquoted
  // parameter expansions. A bare $COMPOSE_FILES therefore reached docker
  // compose as a single argument and it read the filename as
  // " stacks/<stack>/compose.yml", leading space included.
  const script = generateDeployScript([{ name: "umami" }], "/apps", new Set())
  assertEquals(script.includes("--env-file=.env $COMPOSE_FILES"), false)
  assertEquals(script.includes("set -- -f stacks/umami/compose.yml"), true)
  assertEquals(script.includes('--env-file=.env "$@" up -d --build'), true)
})

Deno.test("generateDeployScript looks for compose overrides where the deploy puts them", () => {
  // servers/<server>/compose-override/ is rsynced to <pathApps>/compose-override/,
  // so servers/ does not exist on the remote and that lookup never matched.
  const script = generateDeployScript([{ name: "syncthing" }], "/apps", new Set())
  assertEquals(script.includes('[ -f "/apps/compose-override/syncthing.yml" ]'), true)
  assertEquals(script.includes("servers/syncthing/compose-override"), false)
})

Deno.test("generateDeployScript quotes PATH_APPS in every cd", () => {
  // PATH_APPS comes from the server .env — every remote command built
  // from it must quote it.
  const script = generateDeployScript([{ name: "app" }], "/srv/apps", new Set())
  assertEquals(script.includes("cd /srv/apps "), false)
  assertStringIncludes(script, 'cd "/srv/apps"')
})
