import { assertEquals, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
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
  assertStringIncludes(script, "docker compose -p 'test-stack'")
  assertStringIncludes(script, "f 'stacks/test-stack/compose.yml'")
})

Deno.test("generateDeployScript includes stale-container cleanup before up -d", () => {
  // Prevents "name already in use" when a previous deployment used a
  // different compose project name (e.g. manual `docker compose up` that
  // picked up `name: ${PROJECT}` from compose.yml, producing project=hl,
  // vs deploy's -p ${stack} producing project=${stack}).
  const stacks: StackConfig[] = [{ name: "healthchecks" }]
  const script = generateDeployScript(stacks, "/apps", new Set())
  assertStringIncludes(script, "docker ps -a --filter 'name=hl-healthchecks'")
  assertStringIncludes(script, "com.docker.compose.project")
  assertStringIncludes(script, "docker rm -f")
  assertStringIncludes(script, "\"$proj\" != 'healthchecks'")
})

Deno.test("generateDeployScript adds restart when stack needs restart", () => {
  const stacks: StackConfig[] = [{ name: "traefik" }]
  const script = generateDeployScript(stacks, "/apps", new Set(["traefik"]))
  assertStringIncludes(script, "RESTARTING:traefik:traefik")
  assertStringIncludes(script, "docker compose -p 'traefik' \"$@\" restart")
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
  assertEquals(script.includes("set -- -f 'stacks/umami/compose.yml'"), true)
  assertEquals(script.includes('--env-file=.env "$@" up -d --build'), true)
})

Deno.test("generateDeployScript looks for compose overrides where the deploy puts them", () => {
  // servers/<server>/compose-override/ is rsynced to <pathApps>/compose-override/,
  // so servers/ does not exist on the remote and that lookup never matched.
  const script = generateDeployScript([{ name: "syncthing" }], "/apps", new Set())
  assertEquals(script.includes("[ -f '/apps/compose-override/syncthing.yml' ]"), true)
  assertEquals(script.includes("servers/syncthing/compose-override"), false)
})

Deno.test("generateDeployScript single-quotes PATH_APPS in every cd", () => {
  // PATH_APPS comes from the server .env — every remote command built
  // from it must quote it. Single, not double: double quotes still let
  // $(...) run inside them.
  const script = generateDeployScript([{ name: "app" }], "/srv/apps", new Set())
  assertEquals(script.includes("cd /srv/apps "), false)
  assertEquals(script.includes('cd "/srv/apps"'), false)
  assertStringIncludes(script, "cd '/srv/apps'")
})

Deno.test(
  "generateDeployScript: a PATH_APPS/stack name with $(), \" and ' never executes as a command",
  async () => {
    // Real end-to-end proof: run the generated script through `sh -c`
    // with a fake `docker` on PATH that just logs its argv, and confirm
    // the embedded $(...) never ran and the fake docker received the
    // literal values.
    const tmp = await Deno.makeTempDir({ prefix: "rostok-deploy-script-inject-" })
    const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-docker-" })
    const dockerLog = join(binDir, "docker.log")
    try {
      const weirdDirName = `apps$(touch ${tmp}/INJECTED)"quote'quote`
      const pathApps = join(tmp, weirdDirName)
      await Deno.mkdir(pathApps, { recursive: true })
      const stackName = `evil$(touch ${tmp}/INJECTED-STACK)name`

      await Deno.writeTextFile(
        join(binDir, "docker"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(dockerLog)}\nexit 0\n`,
        { mode: 0o755 },
      )

      const script = generateDeployScript([{ name: stackName }], pathApps, new Set())
      const previousPath = Deno.env.get("PATH") ?? ""
      Deno.env.set("PATH", `${binDir}:${previousPath}`)
      let result: Deno.CommandOutput
      try {
        const proc = new Deno.Command("sh", {
          args: ["-c", script],
          stdout: "piped",
          stderr: "piped",
        })
        result = await proc.output()
      } finally {
        Deno.env.set("PATH", previousPath)
      }
      const stdout = new TextDecoder().decode(result.stdout)
      if (!result.success) console.error(new TextDecoder().decode(result.stderr))
      assertEquals(result.success, true)

      // The script reached DEPLOY_SUCCESS, which only happens if `cd` into
      // the weird pathApps and the fake `docker compose` both actually ran
      // — proof the value reached them as real arguments, not broken text.
      assertStringIncludes(stdout, `DEPLOY_SUCCESS:${stackName}:${stackName}`)

      // Neither embedded $(...) ever ran.
      assertEquals(await Deno.stat(join(tmp, "INJECTED")).catch(() => null), null)
      assertEquals(await Deno.stat(join(tmp, "INJECTED-STACK")).catch(() => null), null)

      // The fake docker received the stack name literally, un-mangled
      // (via --filter name=hl-<stack> and -f stacks/<stack>/compose.yml).
      const dockerCalls = await Deno.readTextFile(dockerLog)
      assertStringIncludes(dockerCalls, stackName)
    } finally {
      await Deno.remove(tmp, { recursive: true })
      await Deno.remove(binDir, { recursive: true })
    }
  },
)

Deno.test("printDeploySummary strips OSC and CSI escape sequences from a stack's error (#250)", () => {
  const lines: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => lines.push(args.join(" "))
  try {
    printDeploySummary([
      {
        name: "web",
        deployAs: "web",
        success: false,
        error: "\x1b]0;PWNED\x07compose \x1b[31mfailed\x9b2J",
      },
    ])
  } finally {
    console.log = originalLog
  }
  const out = lines.join("\n")
  // deno-lint-ignore no-control-regex
  assertEquals(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(out), false, JSON.stringify(out))
  assertStringIncludes(out, "compose")
  assertStringIncludes(out, "failed")
})
