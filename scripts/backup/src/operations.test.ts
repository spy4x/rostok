// Runs BackupOperations against a fake `docker` shell script that logs every
// call (cwd + args, and separately the variables it received) and answers from
// files in its directory: the up -d fallback gets a cleaned environment, so
// the fake is not configured through env vars. The fake never calls a real
// docker, and exits non-zero if it is ever invoked from itself (depth guard).

import { assertEquals, assertStringIncludes } from "@std/assert"
import { BackupStatus } from "./types.ts"
import type { BackupConfigState } from "./types.ts"

/** The fake `docker`; `dir` holds its logs and canned answers. */
function fakeDocker(dir: string): string {
  return `#!/bin/sh
if [ -n "$FAKE_DOCKER_DEPTH" ]; then echo "fake docker recursed" >&2; exit 99; fi
export FAKE_DOCKER_DEPTH=1
printf '%s|%s\\n' "$PWD" "$*" >> '${dir}/docker.log'
printf 'VOLUMES_PATH=%s|PATH_APPS=%s|HOME=%s|DOCKER_HOST=%s|DOCKER_CONFIG=%s\\n' \\
  "$VOLUMES_PATH" "$PATH_APPS" "$HOME" "$DOCKER_HOST" "$DOCKER_CONFIG" >> '${dir}/env.log'
case "$1" in
  ps) cat '${dir}/ps-output'; exit 0 ;;
  compose)
    case "$*" in
      *" start") [ -s '${dir}/start-stderr' ] && { cat '${dir}/start-stderr' >&2; exit 1; } ;;
    esac
    exit 0 ;;
esac
exit 0
`
}

const MISSING = `service "app" has no container to start`

/** What the fake docker answers. */
interface FakeAnswers {
  /** stdout of `docker ps` */
  ps?: string
  /** stderr of a failing `docker compose ... start`; empty means start succeeds */
  startStderr?: string
}

interface Harness {
  dir: string
  /** `<cwd>|<args>` per docker call */
  log: () => string[]
  /** `VOLUMES_PATH=..|PATH_APPS=..|HOME=..|DOCKER_HOST=..|DOCKER_CONFIG=..` per docker call */
  envLog: () => string[]
  run: (
    action: "start" | "stop",
    config?: BackupConfigState,
  ) => Promise<BackupConfigState>
  config: BackupConfigState
}

/** The runner's own environment in every test, as read from its server env file. */
const RUNNER_ENV: Record<string, string> = {
  SSH_USER: `tester`,
  PATH_APPS: `/nonexistent/old-checkout`,
  VOLUMES_PATH: `/nonexistent/volumes`,
  PATH_SYNC: `/nonexistent/sync`,
  SERVER_NAME: `test`,
  DOCKER_HOST: `unix:///nonexistent/docker.sock`,
  HOME: `/nonexistent/root`,
}

async function withHarness(
  answers: FakeAnswers,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir()
  const saved = new Map<string, string | undefined>()
  try {
    const bin = `${dir}/bin`
    await Deno.mkdir(bin)
    await Deno.writeTextFile(`${bin}/docker`, fakeDocker(dir), { mode: 0o755 })
    await Deno.writeTextFile(`${dir}/docker.log`, ``)
    await Deno.writeTextFile(`${dir}/env.log`, ``)
    await Deno.writeTextFile(`${dir}/ps-output`, answers.ps ?? ``)
    await Deno.writeTextFile(`${dir}/start-stderr`, answers.startStderr ?? ``)
    const env = { ...RUNNER_ENV, PATH: `${bin}:${Deno.env.get("PATH")}` }
    for (const [k, v] of Object.entries(env)) {
      saved.set(k, Deno.env.get(k))
      Deno.env.set(k, v)
    }
    saved.set(`DOCKER_CONFIG`, Deno.env.get(`DOCKER_CONFIG`))
    Deno.env.delete(`DOCKER_CONFIG`)
    const { BackupOperations } = await import(`./operations.ts?bust=${crypto.randomUUID()}`)
    const ops = new BackupOperations(`pw`)
    const config: BackupConfigState = {
      name: `app`,
      sourcePaths: [],
      containers: { stop: ["__compose__"] },
      fileName: `app/backup.ts`,
      status: BackupStatus.IN_PROGRESS,
    }
    const lines = (file: string) =>
      Deno.readTextFileSync(`${dir}/${file}`).split("\n").filter(Boolean)
    await fn({
      dir,
      config,
      log: () => lines(`docker.log`),
      envLog: () => lines(`env.log`),
      run: async (action, c = config) => {
        await ops.manageContainers(c, action)
        return c
      },
    })
  } finally {
    for (const [k, v] of saved) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v)
    await Deno.remove(dir, { recursive: true })
  }
}

/** A `docker ps` line: project, config files, working dir. */
function psLine(project: string, files: string, wd: string): string {
  return `${project}\t${files}\t${wd}\n`
}

/** Runs `fn` with an existing temp dir as the apps root, removed afterwards. */
async function withAppsRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir()
  try {
    await fn(root)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
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
      ps: psLine(`app`, files, `${wd}/stacks/app`),
      startStderr: MISSING,
    }, async (h) => {
      await h.run("stop")
      const c = await h.run("start")
      assertEquals(c.status, BackupStatus.IN_PROGRESS)
      assertEquals(h.log().slice(1), [
        `${wd}|compose -p app -f ${files} --env-file=.env.root --env-file=.env stop`,
        `${wd}|compose -p app -f ${files} --env-file=.env.root --env-file=.env start`,
        `${wd}|compose -p app -f ${files} --env-file=.env.root --env-file=.env up -d`,
      ])
      // None of the compose commands touched the runner's own PATH_APPS.
      assertEquals(h.log().some((l) => l.includes(`old-checkout`)), false)
    })
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("runs up -d without the runner's VOLUMES_PATH and PATH_APPS, the rest with them", async () => {
  // Compose prefers its process env over --env-file, so a leaked VOLUMES_PATH
  // would rebuild the stack on the runner's paths, not the deployed ones.
  const root = await Deno.makeTempDir()
  try {
    await Deno.mkdir(`${root}/stacks/app`, { recursive: true })
    for (const f of [`.env.root`, `.env`, `stacks/app/compose.yml`]) {
      await Deno.writeTextFile(`${root}/${f}`, ``)
    }
    await withHarness({
      ps: psLine(`app`, `${root}/stacks/app/compose.yml`, `${root}/stacks/app`),
      startStderr: MISSING,
    }, async (h) => {
      await h.run("stop")
      const c = await h.run("start")
      assertEquals(c.status, BackupStatus.IN_PROGRESS)
      // ps, stop, start and the up -d fallback
      assertEquals(h.log().filter((l) => l.endsWith(` up -d`)).length, 1)
      // ps, stop and start keep the runner's env, so required variables resolve
      // even without env files. up -d: DOCKER_* still reaches docker, HOME is
      // the data owner's, and docker's own config stays the runner's.
      const inherited = `VOLUMES_PATH=${RUNNER_ENV.VOLUMES_PATH}|` +
        `PATH_APPS=${RUNNER_ENV.PATH_APPS}|HOME=${RUNNER_ENV.HOME}|` +
        `DOCKER_HOST=${RUNNER_ENV.DOCKER_HOST}|DOCKER_CONFIG=`
      const clean = `VOLUMES_PATH=|PATH_APPS=|HOME=/home/tester|` +
        `DOCKER_HOST=${RUNNER_ENV.DOCKER_HOST}|DOCKER_CONFIG=${RUNNER_ENV.HOME}/.docker`
      assertEquals(h.envLog(), [inherited, inherited, inherited, clean])
    })
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

for (const missing of [`.env.root`, `.env`, `stacks/app/compose.yml`]) {
  Deno.test(`leaves the stack stopped and reports failure when ${missing} is gone before up -d`, async () => {
    const root = await Deno.makeTempDir()
    try {
      await Deno.mkdir(`${root}/stacks/app`, { recursive: true })
      for (const f of [`.env.root`, `.env`, `stacks/app/compose.yml`]) {
        if (f !== missing) await Deno.writeTextFile(`${root}/${f}`, ``)
      }
      await withHarness({
        ps: psLine(`app`, `${root}/stacks/app/compose.yml`, `${root}/stacks/app`),
        startStderr: MISSING,
      }, async (h) => {
        await h.run("stop")
        const c = await h.run("start")
        assertEquals(c.status, BackupStatus.ERROR)
        assertStringIncludes(c.error ?? ``, `left stopped`)
        assertStringIncludes(c.error ?? ``, `(missing: ${root}/${missing})`)
        assertEquals(h.log().some((l) => l.includes(` up `)), false)
      })
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })
}

Deno.test("runs no compose command when no container of the stack is running", async () => {
  await withHarness({
    ps: psLine(`other`, `/srv/stacks/other/compose.yml`, `/srv`),
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
    await withHarness(
      { ps: psLine(`nginx-b`, files, `${root}/stacks/app`) },
      async (h) => {
        await h.run("stop")
        assertEquals(
          h.log()[1],
          `${root}|compose -p nginx-b -f ${root}/stacks/app/compose.yml -f ${root}/compose-override/app.yml stop`,
        )
      },
    )
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("refuses to stop a stack that runs from two compose projects and names both", async () => {
  await withAppsRoot(async (root) => {
    // Both apps roots exist, so stopping either one would succeed.
    for (const dir of [`one`, `two`]) await Deno.mkdir(`${root}/${dir}`)
    await withHarness({
      ps: psLine(`a`, `${root}/one/stacks/app/compose.yml`, `${root}/one/stacks/app`) +
        psLine(`b`, `${root}/two/stacks/app/compose.yml`, `${root}/two/stacks/app`),
    }, async (h) => {
      const c = await h.run("stop")
      assertEquals(c.status, BackupStatus.ERROR)
      assertStringIncludes(c.error ?? ``, `(a in ${root}/one, b in ${root}/two)`)
      assertEquals(h.log().filter((l) => l.includes(`|compose `)), [])
    })
  })
})

Deno.test("fails the backup instead of copying live when a running stack matches no compose file", async () => {
  await withHarness({
    ps: psLine(`app`, `/srv/elsewhere/app.yml`, `/srv/elsewhere`),
  }, async (h) => {
    const c = await h.run("stop")
    assertEquals(c.status, BackupStatus.ERROR)
    assertStringIncludes(c.error ?? ``, `copied live`)
    assertEquals(h.log().filter((l) => l.includes(`|compose `)), [])
  })
})

Deno.test("stops a project whose services carry different compose file lists with the longest list", async () => {
  await withAppsRoot(async (root) => {
    // `rostok deploy` added an override that changed only service a, so only a
    // was recreated with it; b keeps the stack's own file alone.
    const base = `${root}/stacks/app/compose.yml`
    const override = `${root}/compose-override/app.yml`
    await withHarness({
      ps: psLine(`app`, base, `${root}/stacks/app`) +
        psLine(`app`, `${base},${override}`, `${root}/stacks/app`),
    }, async (h) => {
      const c = await h.run("stop")
      assertEquals(c.status, BackupStatus.IN_PROGRESS)
      assertEquals(h.log().filter((l) => l.includes(`|compose `)), [
        `${root}|compose -p app -f ${base} -f ${override} stop`,
      ])
    })
  })
})

// The longer list must contain the shorter one in the same order: compose
// merges files in list order, so a reordered list is a different config.
const MISFITS: [string, (root: string) => string][] = [
  [`other files`, (root) => `${root}/stacks/app/compose.yml,${root}/three.yml`],
  [`the same files reordered`, (root) => `${root}/one.yml,${root}/stacks/app/compose.yml`],
]
for (const [name, second] of MISFITS) {
  Deno.test(`fails with the real cause when one project's compose file lists do not fit together (${name})`, async () => {
    await withAppsRoot(async (root) => {
      const first = `${root}/stacks/app/compose.yml,${root}/one.yml,${root}/two.yml`
      await withHarness({
        ps: psLine(`app`, first, `${root}/stacks/app`) +
          psLine(`app`, second(root), `${root}/stacks/app`),
      }, async (h) => {
        const c = await h.run("stop")
        assertEquals(c.status, BackupStatus.ERROR)
        assertStringIncludes(c.error ?? ``, `do not fit together`)
        assertEquals(h.log().filter((l) => l.includes(`|compose `)), [])
      })
    })
  })
}

Deno.test("stops a running stack whose containers have no working_dir label", async () => {
  await withAppsRoot(async (root) => {
    await withHarness({
      ps: psLine(`app`, `${root}/stacks/app/compose.yml`, ``),
    }, async (h) => {
      await h.run("stop")
      assertEquals(h.log().filter((l) => l.includes(`|compose `)), [
        `${root}|compose -p app -f ${root}/stacks/app/compose.yml stop`,
      ])
    })
  })
})

Deno.test("fails the stack's backup instead of throwing when its apps root is gone", async () => {
  await withHarness({
    ps: psLine(`app`, `/nonexistent/apps/stacks/app/compose.yml`, `/nonexistent/apps/stacks/app`),
  }, async (h) => {
    const stopped = await h.run("stop")
    assertEquals(stopped.status, BackupStatus.ERROR)
    assertEquals(stopped.errorAtStep, `compose_stop`)
    // The runner restarts in a `finally`; a throw there would end the whole run.
    const started = await h.run("start")
    assertEquals(started.errorAtStep, `compose_start`)
  })
})
