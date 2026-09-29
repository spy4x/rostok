import { assertEquals, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import {
  generateDeployScript,
  parseDeployResults,
  printDeploySummary,
  type StackConfig,
} from "./deploy-script.ts"
import { shQuote } from "./exec.ts"

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

/** What a fake `docker` saw and did while a generated deploy script ran. */
interface FakeDockerRun {
  stdout: string
  /** Every `docker` argv, one line each. */
  calls: string[]
  /** IDs passed to `docker rm -f`. */
  removed: string[]
}

/**
 * Run the deploy script generated for `stack` through `sh` with a fake
 * `docker` on PATH. `docker compose ... config` prints `composeConfig`,
 * `docker ps` prints `psLines` (`<name> <id> <project> [<config files>]`,
 * `-` for an empty label; the config files default to the stack's own
 * compose file), `docker rm -f` records the ID, and everything else
 * succeeds silently.
 */
async function runWithFakeDocker(
  stack: StackConfig,
  composeConfig: string,
  psLines: string[],
): Promise<FakeDockerRun> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-stale-cleanup-" })
  try {
    const pathApps = join(dir, "apps")
    const binDir = join(dir, "bin")
    await Deno.mkdir(pathApps)
    await Deno.mkdir(binDir)
    const log = join(dir, "docker.log")
    const removedLog = join(dir, "removed.log")
    await Deno.writeTextFile(join(dir, "config.yml"), composeConfig)
    const ownFile = `/srv/apps/stacks/${stack.name}/compose.yml`
    const ps = psLines.map((l) => {
      const [name, id, project = "", files = ownFile] = l.split(" ")
      return [name, id, project, files].map((f) => (f === "-" ? "" : f)).join("|") + "\n"
    })
    await Deno.writeTextFile(join(dir, "ps.txt"), ps.join(""))
    await Deno.writeTextFile(log, "")
    await Deno.writeTextFile(removedLog, "")
    await Deno.writeTextFile(
      join(binDir, "docker"),
      [
        "#!/bin/sh",
        '[ -n "$FAKE_DOCKER_DEPTH" ] && exit 97',
        "export FAKE_DOCKER_DEPTH=1",
        `printf '%s\\n' "$*" >> ${shQuote(log)}`,
        'case " $* " in',
        `  *" config "*) cat ${shQuote(join(dir, "config.yml"))} ;;`,
        `  " ps -a "*) cat ${shQuote(join(dir, "ps.txt"))} ;;`,
        `  " rm -f "*) printf '%s\\n' "$3" >> ${shQuote(removedLog)} ;;`,
        "esac",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    )
    const script = generateDeployScript([stack], pathApps, new Set())
    const result = await new Deno.Command("sh", {
      args: ["-c", script],
      env: { PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}` },
      stdout: "piped",
      stderr: "piped",
    }).output()
    const stdout = new TextDecoder().decode(result.stdout)
    assertEquals(result.success, true, new TextDecoder().decode(result.stderr))
    const lines = async (path: string) =>
      (await Deno.readTextFile(path)).split("\n").filter((l) => l !== "")
    return { stdout, calls: await lines(log), removed: await lines(removedLog) }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

const FOO_CONFIG = [
  "name: foo",
  "services:",
  "  foo:",
  "    container_name: hl-foo",
  "    image: example/foo",
  "  worker:",
  "    image: example/foo",
  "networks:",
  "  default:",
  "    name: foo_default",
  "",
].join("\n")

Deno.test("stale-container cleanup never removes another project's container whose name only overlaps foo's (#304)", async () => {
  // Docker's `--filter name=hl-foo` matches substrings, so the old cleanup
  // removed hl-foo-bar and hl-foobar of other projects too. hl-fo guards the
  // other direction: a name that is a prefix of this stack's container_name.
  const run = await runWithFakeDocker({ name: "foo" }, FOO_CONFIG, [
    "hl-foo-bar id-foo-bar other",
    "hl-foobar id-foobar other",
    "my-hl-foo id-my-hl-foo other",
    "hl-foo-db id-foo-db hl",
    "hl-fo id-fo other",
  ])
  assertEquals(run.removed, [])
  assertStringIncludes(run.stdout, "DEPLOY_SUCCESS:foo:foo")
})

Deno.test("stale-container cleanup removes this stack's exact container_name under an old project", async () => {
  // Same container_name under two different projects → "name already in
  // use" on `up`, so the old project's container must still go.
  const run = await runWithFakeDocker({ name: "foo" }, FOO_CONFIG, [
    "hl-foo-bar id-foo-bar other",
    "hl-foo id-old-foo hl",
    "unlabelled id-unlabelled ",
  ])
  assertEquals(run.removed, ["id-old-foo"])
  assertStringIncludes(run.stdout, "removing stale container hl-foo (project=hl, expected=foo)")
})

Deno.test("stale-container cleanup keeps this stack's container in the deployed project", async () => {
  const run = await runWithFakeDocker({ name: "foo" }, FOO_CONFIG, ["hl-foo id-foo foo"])
  assertEquals(run.removed, [])
})

Deno.test("stale-container cleanup reads names from the resolved config of a deployAs stack", async () => {
  // nginx deployed as neatsoft-landing sets container_name from
  // NGINX_CONTAINER_NAME, so the name exists only after compose resolves it
  // with the same env files, project and compose files as `up`.
  const config = [
    "name: neatsoft-landing",
    "services:",
    "  nginx:",
    "    container_name: neatsoft-landing",
    "    image: nginx:alpine",
    "",
  ].join("\n")
  const run = await runWithFakeDocker({ name: "nginx", deployAs: "neatsoft-landing" }, config, [
    "neatsoft-landing id-old hl",
    "neatsoft-landing-preview id-preview other",
    "hl-nginx id-hl-nginx other",
  ])
  assertEquals(run.removed, ["id-old"])
  const configCall = run.calls.find((c) => c.endsWith(" config"))
  assertEquals(
    configCall,
    "compose -p neatsoft-landing --env-file=.env.root --env-file=.env " +
      "-f stacks/nginx/compose.yml config",
  )
})

Deno.test("stale-container cleanup ignores container_name keys outside services", async () => {
  // A top-level `x-` extension block can hold a container_name template; it
  // is not a container `up` creates.
  const config = [
    "name: foo",
    "services:",
    "  foo:",
    "    image: example/foo",
    "x-template:",
    "    container_name: hl-shared",
    "",
  ].join("\n")
  const run = await runWithFakeDocker({ name: "foo" }, config, ["hl-shared id-shared other"])
  assertEquals(run.removed, [])
})

Deno.test("stale-container cleanup strips the quotes compose adds to a numeric name", async () => {
  const config = ["services:", "  foo:", '    container_name: "0123"', ""].join("\n")
  const run = await runWithFakeDocker({ name: "foo" }, config, ["0123 id-num hl"])
  assertEquals(run.removed, ["id-num"])
})

Deno.test("stale-container cleanup strips the single quotes Compose 5.5 adds to a boolean-looking name", async () => {
  const config = ["services:", "  foo:", "    container_name: 'yes'", ""].join("\n")
  const run = await runWithFakeDocker({ name: "foo" }, config, ["yes id-yes hl"])
  assertEquals(run.removed, ["id-yes"])
})

Deno.test("stale-container cleanup ignores container_name text inside a service's block values", async () => {
  // `command` and `environment` values are indented deeper than the
  // service's own keys, so only the key at exactly 4 spaces is a name.
  const config = [
    "services:",
    "  foo:",
    "    command:",
    "      - echo",
    "      - container_name: hl-evil",
    "    environment:",
    "      NOTE: |",
    "        container_name: hl-evil2",
    "    image: example/foo",
    "",
  ].join("\n")
  const run = await runWithFakeDocker({ name: "foo" }, config, [
    "hl-evil id-evil other",
    "hl-evil2 id-evil2 other",
  ])
  assertEquals(run.removed, [])
})

Deno.test("stale-container cleanup never removes another stack's container that a wrong container_name points at", async () => {
  // NGINX_CONTAINER_NAME=hl-traefik by mistake: the name matches, but the
  // container was created from stacks/traefik/compose.yml, so it stays and
  // `up` fails on the conflict instead.
  const config = ["services:", "  nginx:", "    container_name: hl-traefik", ""].join("\n")
  const run = await runWithFakeDocker({ name: "nginx", deployAs: "blog" }, config, [
    "hl-traefik id-traefik traefik /srv/apps/stacks/traefik/compose.yml",
    "hl-traefik id-mynginx traefik /srv/apps/stacks/mynginx/compose.yml",
    "hl-traefik id-mystacks traefik /srv/apps/mystacks/nginx/compose.yml",
  ])
  assertEquals(run.removed, [])
  assertStringIncludes(run.stdout, "keeping container hl-traefik")
})

Deno.test("stale-container cleanup never removes a container without a compose project label", async () => {
  const run = await runWithFakeDocker({ name: "foo" }, FOO_CONFIG, ["hl-foo id-plain -"])
  assertEquals(run.removed, [])
})

Deno.test("stale-container cleanup removes an old-project container created from this stack's file plus an override", async () => {
  const run = await runWithFakeDocker({ name: "foo" }, FOO_CONFIG, [
    "hl-foo id-old hl /srv/old/stacks/foo/compose.yml,/srv/old/compose-override/foo.yml",
  ])
  assertEquals(run.removed, ["id-old"])
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
      // (via -f stacks/<stack>/compose.yml).
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
