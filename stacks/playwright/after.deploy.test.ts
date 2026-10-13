// Tests for the pure helpers of stacks/playwright/after.deploy.ts (spy4x/rostok#338).
// Docker is a fake on PATH here; the pull request body says how the script ran on a real one.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import { parse } from "yaml"
import { buildConnectScript, buildSshArgs } from "./after.deploy.ts"

/** What the fake `docker` answers. */
interface FakeDocker {
  /** Whether `docker network inspect` finds the network. */
  network: boolean
  /** Whether `docker inspect <container>` finds the client. */
  client: boolean
  /** The networks the client is on already, as `docker inspect -f` prints them. */
  clientNetworks: string
}

/**
 * Runs `fn` with a fake `docker` first on PATH and returns what it was called with, one call per
 * line. The fake never reaches a real Docker daemon and calls no other program by the name
 * `docker`; its depth guard makes it exit 97 if it is ever entered from itself.
 */
async function withFakeDocker(
  fake: FakeDocker,
  fn: (env: Record<string, string>) => Promise<void>,
): Promise<string[]> {
  const binDir = await Deno.makeTempDir({ prefix: `rostok-fake-docker-` })
  const logPath = `${binDir}/calls.log`
  try {
    const script = `#!/bin/sh
[ -n "$FAKE_DOCKER_DEPTH" ] && exit 97
export FAKE_DOCKER_DEPTH=1
echo "$*" >> "${logPath}"
case "$1 $2" in
  "network inspect") exit ${fake.network ? 0 : 1} ;;
  "network connect") exit 0 ;;
  "inspect -f") echo "${fake.clientNetworks}" ;;
  inspect*) exit ${fake.client ? 0 : 1} ;;
  *) exit 98 ;;
esac
`
    await Deno.writeTextFile(`${binDir}/docker`, script, { mode: 0o755 })
    await Deno.writeTextFile(logPath, ``)
    const env = Deno.env.toObject()
    for (const key of [`SSH_HOST`, `SSH_PORT`, `SSH_USER`, `FAKE_DOCKER_DEPTH`]) delete env[key]
    await fn({ ...env, PATH: `${binDir}:${env.PATH ?? ``}` })
    return (await Deno.readTextFile(logPath)).split(`\n`).filter((line) => line.length > 0)
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
}

/** Runs the hook as deploy does on a local server: no SSH_HOST. Returns its exit code. */
async function runHookLocally(env: Record<string, string>): Promise<number> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [`run`, `-A`, import.meta.resolve(`./after.deploy.ts`)],
    env,
    clearEnv: true,
    stdout: `null`,
    stderr: `null`,
  }).output()
  return output.code
}

Deno.test("after.deploy.ts subprocess: without SSH_HOST it connects Open WebUI through the local docker and exits 0", async () => {
  let code = -1
  const calls = await withFakeDocker(
    { network: true, client: true, clientNetworks: `proxy ` },
    async (env) => {
      code = await runHookLocally(env)
    },
  )
  assertEquals(code, 0)
  assertEquals(calls.at(-1), `network connect hl-playwright-mcp hl-open-webui`)
})

Deno.test("after.deploy.ts subprocess: on a local server without Open WebUI it connects nothing and exits 0", async () => {
  let code = -1
  const calls = await withFakeDocker(
    { network: true, client: false, clientNetworks: `` },
    async (env) => {
      code = await runHookLocally(env)
    },
  )
  assertEquals(code, 0)
  assertEquals(calls, [`network inspect hl-playwright-mcp`, `inspect hl-open-webui`])
})

Deno.test("buildConnectScript: skips a server without the network or the client, then connects the client", () => {
  const lines = buildConnectScript(`hl-playwright-mcp`, `hl-open-webui`).split(`\n`)
  assertEquals(lines.length, 4)
  assertStringIncludes(lines[0], `docker network inspect hl-playwright-mcp >/dev/null 2>&1 || {`)
  assertStringIncludes(lines[0], `exit 0; }`)
  assertStringIncludes(lines[1], `docker inspect hl-open-webui >/dev/null 2>&1 || {`)
  assertStringIncludes(lines[1], `exit 0; }`)
  assertStringIncludes(lines[2], `grep -qx hl-playwright-mcp; then`)
  assertStringIncludes(lines[3], `docker network connect hl-playwright-mcp hl-open-webui &&`)
})

Deno.test("buildConnectScript: refuses a name that could carry shell syntax", () => {
  assertThrows(
    () => buildConnectScript(`net; rm -rf /`, `hl-open-webui`),
    Error,
    `invalid Docker name`,
  )
  assertThrows(() => buildConnectScript(`hl-playwright-mcp`, `$(id)`), Error, `invalid Docker name`)
})

Deno.test("buildSshArgs: -p only with a port, the options, '--', the target, then the script as one argument", () => {
  assertEquals(buildSshArgs(`192.0.2.10`, `2222`, `user`, `echo hi`), [
    `-p`,
    `2222`,
    `-o`,
    `ConnectTimeout=10`,
    `-o`,
    `BatchMode=yes`,
    `--`,
    `user@192.0.2.10`,
    `echo hi`,
  ])
  assertEquals(buildSshArgs(`homelab`, undefined, undefined, `echo hi`), [
    `-o`,
    `ConnectTimeout=10`,
    `-o`,
    `BatchMode=yes`,
    `--`,
    `homelab`,
    `echo hi`,
  ])
})

Deno.test("buildSshArgs: rejects a port that is not a port number", () => {
  assertThrows(
    () => buildSshArgs(`homelab`, `22;id`, undefined, `echo hi`),
    Error,
    `invalid SSH_PORT`,
  )
  assertThrows(
    () => buildSshArgs(`homelab`, `70000`, undefined, `echo hi`),
    Error,
    `invalid SSH_PORT`,
  )
})

Deno.test("after.deploy.ts: connects Open WebUI to the network compose.yml creates", async () => {
  const compose = parse(await Deno.readTextFile(new URL(`./compose.yml`, import.meta.url))) as {
    networks: Record<string, { name?: string }>
  }
  const source = await Deno.readTextFile(new URL(`./after.deploy.ts`, import.meta.url))
  assertStringIncludes(source, `const NETWORK = \`${compose.networks.mcp.name}\``)
  assertStringIncludes(source, "const CLIENT = `hl-open-webui`")
})
