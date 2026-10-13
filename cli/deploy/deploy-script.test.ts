import { assertEquals, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import {
  type DeployResult,
  generateDeployScript,
  parseDeployResults,
  printDeploySummary,
  type StackConfig,
  VERIFY_LOG_LINES,
  VERIFY_WAIT_SECONDS,
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
  /** The argument of every `sleep`, in order. */
  sleeps: string[]
}

/** What the fake `docker` and `sleep` answer while the script runs. */
interface FakeDockerOptions {
  /** Printed by `docker compose ... config`. */
  composeConfig?: string
  /** `docker ps -a` lines: `<name> <id> <project> [<config files>]`, `-` for an empty label. */
  psLines?: string[]
  /**
   * Containers as `<project>|<id>|/<name>|<status>|<exit code>|<restart count>|<finished at>`,
   * right after `up -d` and after the wait. `after` defaults to `before`.
   */
  before?: string[]
  after?: string[]
  /** `docker logs` output per container ID. */
  logs?: Record<string, string>
  /** Makes `docker compose ... up` exit 1. */
  upFails?: boolean
  /** The shell that runs the script (default `sh`). */
  shell?: Shell
}

/** `sh` or `zsh`: ssh runs the script through the remote user's login shell, often zsh. */
type Shell = "sh" | "zsh"
const SHELLS: Shell[] = ["sh", "zsh"]

/** An exit time later than any run of these tests, and one earlier. */
const AFTER_UP = "9999-01-01T00:00:00.000000000Z"
const LONG_AGO = "2000-01-01T00:00:00.000000000Z"

/**
 * Run the deploy script generated for `stacks` through `sh` with a fake
 * `docker` and a fake `sleep` on PATH. `docker compose ... config` prints
 * `composeConfig`, `docker ps -a` prints `psLines` (the config files default
 * to the first stack's own compose file), `docker rm -f` records the ID,
 * `docker ps -a -q --filter`, `docker inspect` and `docker logs` answer from
 * `before`, `after` and `logs`, and everything else succeeds silently. The
 * fake `sleep` returns at once, records its argument, and switches the fake
 * `docker` from `before` to `after`. Neither fake calls a tool of its own
 * name, and each exits 97 when it finds itself called from itself.
 */
async function runScriptWithFakeDocker(
  stacks: StackConfig[],
  opts: FakeDockerOptions = {},
): Promise<FakeDockerRun> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-stale-cleanup-" })
  try {
    const pathApps = join(dir, "apps")
    const binDir = join(dir, "bin")
    await Deno.mkdir(pathApps)
    await Deno.mkdir(binDir)
    await Deno.mkdir(join(dir, "logs"))
    const log = join(dir, "docker.log")
    const removedLog = join(dir, "removed.log")
    const sleepLog = join(dir, "sleep.log")
    const slept = join(dir, "slept")
    await Deno.writeTextFile(join(dir, "config.yml"), opts.composeConfig ?? "")
    const ownFile = `/srv/apps/stacks/${stacks[0].name}/compose.yml`
    const ps = (opts.psLines ?? []).map((l) => {
      const [name, id, project = "", files = ownFile] = l.split(" ")
      return [name, id, project, files].map((f) => (f === "-" ? "" : f)).join("|") + "\n"
    })
    await Deno.writeTextFile(join(dir, "ps.txt"), ps.join(""))
    const before = opts.before ?? []
    const asFile = (lines: string[]) => lines.map((l) => `${l}\n`).join("")
    await Deno.writeTextFile(join(dir, "before.txt"), asFile(before))
    await Deno.writeTextFile(join(dir, "after.txt"), asFile(opts.after ?? before))
    for (const [id, text] of Object.entries(opts.logs ?? {})) {
      await Deno.writeTextFile(join(dir, "logs", id), text)
    }
    await Deno.writeTextFile(log, "")
    await Deno.writeTextFile(removedLog, "")
    await Deno.writeTextFile(sleepLog, "")
    await Deno.writeTextFile(
      join(binDir, "docker"),
      [
        "#!/bin/sh",
        '[ -n "$FAKE_DOCKER_DEPTH" ] && exit 97',
        "export FAKE_DOCKER_DEPTH=1",
        `printf '%s\\n' "$*" >> ${shQuote(log)}`,
        `state=${shQuote(join(dir, "before.txt"))}`,
        `[ -f ${shQuote(slept)} ] && state=${shQuote(join(dir, "after.txt"))}`,
        'for last in "$@"; do :; done',
        'case " $* " in',
        `  *" config "*) cat ${shQuote(join(dir, "config.yml"))} ;;`,
        `  *" up "*) ${opts.upFails ? "echo 'up went wrong'; exit 1" : ":"} ;;`,
        `  " ps -a -q --filter "*) awk -F'|' -v p="\${last#label=com.docker.compose.project=}" '$1 == p { print $2 }' "$state" ;;`,
        `  " inspect "*) awk -F'|' -v id="$last" '$2 == id { sub(/^[^|]*[|]/, ""); print }' "$state" ;;`,
        `  " logs "*) cat ${shQuote(join(dir, "logs"))}/"$last" ;;`,
        `  " ps -a "*) cat ${shQuote(join(dir, "ps.txt"))} ;;`,
        `  " rm -f "*) printf '%s\\n' "$3" >> ${shQuote(removedLog)} ;;`,
        "esac",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    )
    await Deno.writeTextFile(
      join(binDir, "sleep"),
      [
        "#!/bin/sh",
        '[ -n "$FAKE_SLEEP_DEPTH" ] && exit 97',
        "export FAKE_SLEEP_DEPTH=1",
        `printf '%s\\n' "$*" >> ${shQuote(sleepLog)}`,
        `: > ${shQuote(slept)}`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    )
    const script = generateDeployScript(stacks, pathApps, new Set())
    // zsh gets -f, so the developer's own zsh config never changes the result.
    const result = await new Deno.Command(opts.shell === "zsh" ? "zsh" : "sh", {
      args: opts.shell === "zsh" ? ["-f", "-c", script] : ["-c", script],
      env: { PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}` },
      stdout: "piped",
      stderr: "piped",
    }).output()
    const stdout = new TextDecoder().decode(result.stdout)
    const stderr = new TextDecoder().decode(result.stderr)
    assertEquals(result.success, true, stderr)
    // A shell error inside the look at the containers must not pass as "nothing found".
    assertEquals(stderr, "")
    const lines = async (path: string) =>
      (await Deno.readTextFile(path)).split("\n").filter((l) => l !== "")
    return {
      stdout,
      calls: await lines(log),
      removed: await lines(removedLog),
      sleeps: await lines(sleepLog),
    }
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
}

/** `runScriptWithFakeDocker` for one stack and the stale-container cleanup's inputs. */
function runWithFakeDocker(
  stack: StackConfig,
  composeConfig: string,
  psLines: string[],
): Promise<FakeDockerRun> {
  return runScriptWithFakeDocker([stack], { composeConfig, psLines })
}

/** The parsed result of the one stack `foo` after a run with these containers. */
async function deployFoo(
  opts: FakeDockerOptions,
): Promise<FakeDockerRun & { result: DeployResult }> {
  const stacks: StackConfig[] = [{ name: "foo" }]
  const run = await runScriptWithFakeDocker(stacks, opts)
  return { ...run, result: parseDeployResults(run.stdout, stacks)[0] }
}

for (const shell of SHELLS) {
  Deno.test(`a stack whose container exits with an error after up -d is marked failed, with its last log lines (${shell})`, async () => {
    const run = await deployFoo({
      shell,
      before: [`foo|c1|/hl-foo|running|0|0|0001-01-01T00:00:00Z`],
      after: [`foo|c1|/hl-foo|exited|1|0|${AFTER_UP}`],
      logs: { c1: "starting\nFOO_TOKEN is not set\n" },
    })
    assertEquals(run.result.success, false)
    assertEquals(run.result.containerFailed, true)
    assertEquals(
      run.result.error,
      "Container hl-foo exited with code 1. Its last log lines:\n  starting\n  FOO_TOKEN is not set",
    )
    assertEquals(
      run.calls.includes(`logs --tail ${VERIFY_LOG_LINES} c1`),
      true,
      run.calls.join("\n"),
    )
  })

  Deno.test(`a stack whose containers all keep running is marked successful (${shell})`, async () => {
    const run = await deployFoo({
      shell,
      before: [
        `foo|c1|/hl-foo|running|0|0|0001-01-01T00:00:00Z`,
        `foo|c2|/hl-foo-db|running|0|0|0001-01-01T00:00:00Z`,
      ],
    })
    assertEquals(run.result.success, true)
    assertEquals(run.calls.filter((c) => c.startsWith("logs ")), [])
  })
}

Deno.test("a stack with a restarting container is marked failed", async () => {
  const run = await deployFoo({
    before: [`foo|c1|/hl-foo|running|0|0|0001-01-01T00:00:00Z`],
    after: [`foo|c1|/hl-foo|restarting|1|0|${AFTER_UP}`],
    logs: { c1: "boom\n" },
  })
  assertEquals(run.result.success, false)
  assertStringIncludes(run.result.error ?? "", "Container hl-foo is restarting.")
})

Deno.test("a stack whose container was restarted by Docker during the wait is marked failed, though it is running at the look", async () => {
  const run = await deployFoo({
    shell: "zsh",
    before: [`foo|c1|/hl-foo|running|0|1|${LONG_AGO}`],
    after: [`foo|c1|/hl-foo|running|0|3|${AFTER_UP}`],
    logs: { c1: "boom\n" },
  })
  assertEquals(run.result.success, false)
  assertStringIncludes(run.result.error ?? "", "Container hl-foo keeps restarting.")
})

Deno.test("a running container with restarts from before the deploy does not fail the stack", async () => {
  const run = await deployFoo({ before: [`foo|c1|/hl-foo|running|0|7|${LONG_AGO}`] })
  assertEquals(run.result.success, true)
  assertEquals(run.result.error, undefined)
})

Deno.test("a one-shot container that exited 0 does not fail the stack", async () => {
  const run = await deployFoo({
    before: [
      `foo|c1|/hl-foo|running|0|0|0001-01-01T00:00:00Z`,
      `foo|c2|/hl-foo-migrate|running|0|0|0001-01-01T00:00:00Z`,
    ],
    after: [
      `foo|c1|/hl-foo|running|0|0|0001-01-01T00:00:00Z`,
      `foo|c2|/hl-foo-migrate|exited|0|0|${AFTER_UP}`,
    ],
  })
  assertEquals(run.result.success, true)
})

Deno.test("a container that exited with an error before this deploy does not fail the stack", async () => {
  const run = await deployFoo({
    before: [
      `foo|c1|/hl-foo|running|0|0|${LONG_AGO}`,
      `foo|c2|/hl-foo-old|exited|137|0|${LONG_AGO}`,
    ],
  })
  assertEquals(run.result.success, true)
})

Deno.test("a failed container fails only its own stack, found under the stack's deployAs project", async () => {
  const stacks: StackConfig[] = [{ name: "foo" }, { name: "bar", deployAs: "bar-two" }]
  const run = await runScriptWithFakeDocker(stacks, {
    before: [
      `foo|c1|/hl-foo|running|0|0|0001-01-01T00:00:00Z`,
      `bar-two|c2|/hl-bar|running|0|0|0001-01-01T00:00:00Z`,
    ],
    after: [
      `foo|c1|/hl-foo|running|0|0|0001-01-01T00:00:00Z`,
      `bar-two|c2|/hl-bar|exited|2|0|${AFTER_UP}`,
    ],
    logs: { c2: "bar died\n" },
  })
  const results = parseDeployResults(run.stdout, stacks)
  assertEquals(results.map((r) => r.success), [true, false])
  assertEquals(
    results[1].error,
    "Container hl-bar exited with code 2. Its last log lines:\n  bar died",
  )
})

Deno.test(`a deploy waits ${VERIFY_WAIT_SECONDS} seconds once for all its stacks, not once per stack`, async () => {
  const run = await runScriptWithFakeDocker([{ name: "foo" }, { name: "bar" }, { name: "baz" }], {
    before: [
      `foo|c1|/hl-foo|running|0|0|0001-01-01T00:00:00Z`,
      `bar|c2|/hl-bar|running|0|0|0001-01-01T00:00:00Z`,
      `baz|c3|/hl-baz|running|0|0|0001-01-01T00:00:00Z`,
    ],
  })
  assertEquals(run.sleeps, [String(VERIFY_WAIT_SECONDS)])
  for (const name of ["foo", "bar", "baz"]) {
    assertStringIncludes(run.stdout, `DEPLOY_SUCCESS:${name}:${name}`)
  }
})

Deno.test("a deploy whose stacks have no containers does not wait", async () => {
  const run = await deployFoo({})
  assertEquals(run.sleeps, [])
  assertEquals(run.result.success, true)
})

Deno.test("a stack whose up -d fails is marked failed with up's output, without a look at its containers", async () => {
  const run = await deployFoo({
    upFails: true,
    before: [`foo|c1|/hl-foo|exited|1|0|${AFTER_UP}`],
    logs: { c1: "boom\n" },
  })
  assertEquals(run.result.success, false)
  assertEquals(run.result.containerFailed, undefined)
  assertEquals(run.result.error, "up went wrong")
  assertEquals(run.sleeps, [])
  assertEquals(run.calls.filter((c) => c.startsWith("logs ")), [])
})

Deno.test("parseDeployResults ignores a marker inside a failed container's indented log lines", () => {
  const stacks: StackConfig[] = [{ name: "foo" }, { name: "bar" }]
  const output = [
    "DEPLOY_START:foo:foo",
    "DEPLOY_START:bar:bar",
    "DEPLOY_VERIFY:foo:foo",
    "Container hl-foo exited with code 1. Its last log lines:",
    "  DEPLOY_SUCCESS:foo:foo",
    "  DEPLOY_FAILED:bar:bar",
    "DEPLOY_FAILED:foo:foo",
    "DEPLOY_VERIFY:bar:bar",
    "DEPLOY_SUCCESS:bar:bar",
  ].join("\n")
  const results = parseDeployResults(output, stacks)
  assertEquals(results.map((r) => r.success), [false, true])
})

Deno.test("printDeploySummary prints every log line of a container that failed after up -d", () => {
  const logLines = Array.from(
    { length: VERIFY_LOG_LINES },
    (_, i) => `  log line ${i + 1} ${"x".repeat(40)}`,
  )
  const printed: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => printed.push(args.join(" "))
  try {
    printDeploySummary([{
      name: "foo",
      deployAs: "foo",
      success: false,
      containerFailed: true,
      error: ["Container hl-foo exited with code 1. Its last log lines:", ...logLines].join("\n"),
    }])
  } finally {
    console.log = original
  }
  const text = printed.join("\n")
  assertStringIncludes(text, "Failed (1/1)")
  assertStringIncludes(text, "Container hl-foo exited with code 1.")
  for (const line of logLines) assertStringIncludes(text, line)
})

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
  // nginx deployed as acme-landing sets container_name from
  // NGINX_CONTAINER_NAME, so the name exists only after compose resolves it
  // with the same env files, project and compose files as `up`.
  const config = [
    "name: acme-landing",
    "services:",
    "  nginx:",
    "    container_name: acme-landing",
    "    image: nginx:alpine",
    "",
  ].join("\n")
  const run = await runWithFakeDocker({ name: "nginx", deployAs: "acme-landing" }, config, [
    "acme-landing id-old hl",
    "acme-landing-preview id-preview other",
    "hl-nginx id-hl-nginx other",
  ])
  assertEquals(run.removed, ["id-old"])
  const configCall = run.calls.find((c) => c.endsWith(" config"))
  assertEquals(
    configCall,
    "compose -p acme-landing --env-file=.env.root --env-file=.env " +
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
