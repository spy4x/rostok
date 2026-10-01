// Runs BackupOperations against a fake `docker` shell script that logs every
// call (cwd + args) and answers from env vars. The fake never calls a real
// docker, and exits non-zero if it is ever invoked from itself (depth guard).

import { assertEquals, assertStringIncludes } from "@std/assert"
import { BackupStatus } from "./types.ts"
import type { BackupConfigState } from "./types.ts"

const FAKE_DOCKER = `#!/bin/sh
if [ -n "$FAKE_DOCKER_DEPTH" ]; then echo "fake docker recursed" >&2; exit 99; fi
export FAKE_DOCKER_DEPTH=1
printf '%s|%s\\n' "$PWD" "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  ps) printf '%s' "$FAKE_PS_OUTPUT"; exit 0 ;;
  compose)
    case "$*" in
      *" start") [ -n "$FAKE_START_STDERR" ] && { echo "$FAKE_START_STDERR" >&2; exit 1; } ;;
    esac
    exit 0 ;;
esac
exit 0
`

const MISSING = `service "app" has no container to start`

interface Harness {
  dir: string
  log: () => string[]
  run: (
    action: "start" | "stop",
    config?: BackupConfigState,
  ) => Promise<BackupConfigState>
  ops: { manageContainers(c: BackupConfigState, a: "start" | "stop"): Promise<void> }
  config: BackupConfigState
}

async function harness(env: Record<string, string>): Promise<Harness> {
  const dir = await Deno.makeTempDir()
  const bin = `${dir}/bin`
  await Deno.mkdir(bin)
  await Deno.writeTextFile(`${bin}/docker`, FAKE_DOCKER, { mode: 0o755 })
  const logPath = `${dir}/docker.log`
  await Deno.writeTextFile(logPath, ``)
  const saved = new Map<string, string | undefined>()
  const all: Record<string, string> = {
    SSH_USER: `tester`,
    PATH_APPS: `/nonexistent/old-checkout`,
    VOLUMES_PATH: `/nonexistent/volumes`,
    PATH_SYNC: `/nonexistent/sync`,
    SERVER_NAME: `test`,
    PATH: `${bin}:${Deno.env.get("PATH")}`,
    FAKE_DOCKER_LOG: logPath,
    ...env,
  }
  for (const [k, v] of Object.entries(all)) {
    saved.set(k, Deno.env.get(k))
    Deno.env.set(k, v)
  }
  const { BackupOperations } = await import(`./operations.ts?bust=${crypto.randomUUID()}`)
  const ops = new BackupOperations(`pw`)
  const config: BackupConfigState = {
    name: `app`,
    sourcePaths: [],
    containers: { stop: ["__compose__"] },
    fileName: `app/backup.ts`,
    status: BackupStatus.IN_PROGRESS,
  }
  const restore = () => {
    for (const [k, v] of saved) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v)
  }
  return {
    dir,
    ops,
    config,
    log: () => Deno.readTextFileSync(logPath).split("\n").filter(Boolean),
    run: async (action, c = config) => {
      await ops.manageContainers(c, action)
      return c
    },
    // restore env when the test calls cleanup via dispose
    [Symbol.dispose]: restore,
  } as Harness & { [Symbol.dispose]: () => void }
}

async function withHarness(
  env: Record<string, string>,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const h = await harness(env) as Harness & { [Symbol.dispose]: () => void }
  try {
    await fn(h)
  } finally {
    h[Symbol.dispose]()
    await Deno.remove(h.dir, { recursive: true })
  }
}

/** A `docker ps` line: project, config files, working dir. */
function psLine(project: string, files: string, wd: string): string {
  return `${project}\t${files}\t${wd}\n`
}

Deno.test("stops, starts and rebuilds with the running container's own compose files", async () => {
  const root = await Deno.makeTempDir()
  try {
    const wd = `${root}/rostok/apps`
    await Deno.mkdir(`${wd}/stacks/app`, { recursive: true })
    for (const f of [`.env.root`, `.env`, `stacks/app/compose.yml`]) {
      await Deno.writeTextFile(`${wd}/${f}`, ``)
    }
    const files = `${wd}/stacks/app/compose.yml`
    await withHarness({
      FAKE_PS_OUTPUT: psLine(`app`, files, wd),
      FAKE_START_STDERR: MISSING,
    }, async (h) => {
      await h.run("stop")
      const c = await h.run("start")
      assertEquals(c.status, BackupStatus.IN_PROGRESS)
      assertEquals(h.log().slice(1), [
        `${wd}|compose -p app -f ${files} stop`,
        `${wd}|compose -p app -f ${files} start`,
        `${wd}|compose -p app -f ${files} --env-file=.env.root --env-file=.env up -d`,
      ])
      // None of the compose commands touched the runner's own PATH_APPS.
      assertEquals(h.log().some((l) => l.includes(`old-checkout`)), false)
    })
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("leaves the stack stopped and reports failure when up -d cannot reproduce the env", async () => {
  const root = await Deno.makeTempDir()
  try {
    const wd = `${root}/apps`
    await Deno.mkdir(`${wd}/stacks/app`, { recursive: true })
    await Deno.writeTextFile(`${wd}/stacks/app/compose.yml`, ``)
    // no .env.root and no .env
    const files = `${wd}/stacks/app/compose.yml`
    await withHarness({
      FAKE_PS_OUTPUT: psLine(`app`, files, wd),
      FAKE_START_STDERR: MISSING,
    }, async (h) => {
      await h.run("stop")
      const c = await h.run("start")
      assertEquals(c.status, BackupStatus.ERROR)
      assertStringIncludes(c.error ?? ``, `left stopped`)
      assertStringIncludes(c.error ?? ``, `.env.root`)
      assertEquals(h.log().some((l) => l.includes(` up `)), false)
    })
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("runs no compose command when no container of the stack is running", async () => {
  await withHarness({
    FAKE_PS_OUTPUT: psLine(`other`, `/srv/stacks/other/compose.yml`, `/srv`),
  }, async (h) => {
    await h.run("stop")
    const c = await h.run("start")
    assertEquals(c.status, BackupStatus.IN_PROGRESS)
    assertEquals(h.log().filter((l) => l.includes(`|compose `)), [])
  })
})

Deno.test("uses the deployed project name even when it differs from the stack directory", async () => {
  const root = await Deno.makeTempDir()
  try {
    const files = `${root}/stacks/app/compose.yml,${root}/compose-override/app.yml`
    await withHarness({ FAKE_PS_OUTPUT: psLine(`nginx-b`, files, root) }, async (h) => {
      await h.run("stop")
      assertEquals(
        h.log()[1],
        `${root}|compose -p nginx-b -f ${root}/stacks/app/compose.yml -f ${root}/compose-override/app.yml stop`,
      )
    })
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("refuses to stop a stack that runs from two different compose projects", async () => {
  await withHarness({
    FAKE_PS_OUTPUT: psLine(`a`, `/x/stacks/app/compose.yml`, `/x`) +
      psLine(`b`, `/y/stacks/app/compose.yml`, `/y`),
  }, async (h) => {
    const c = await h.run("stop")
    assertEquals(c.status, BackupStatus.ERROR)
    assertEquals(h.log().filter((l) => l.includes(`|compose `)), [])
  })
})
