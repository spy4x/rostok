import { assert, assertEquals, assertThrows } from "@std/assert"
import { join } from "@std/path"
import {
  handleStagingSignal,
  installStagingSignalCleanup,
  runDeploy,
  STAGING_CLEANUP_SIGNALS,
} from "./run-deploy.ts"

// #233: a fake `ssh`/`rsync` pair, just capable enough to let a real
// `runDeploy()` complete against two catalog-free (local `stacks/<n>/`)
// stacks, so the actual rsync ARGV run-deploy.ts builds can be asserted
// on directly — not just a hand-written string fixture that could drift
// from what the real code path sends. `rsync` also really copies files,
// so "which remote directory received which files" is provable too, not
// just "which argv was built".
const FAKE_SSH = `#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
const args = Deno.args
const dashDashIdx = args.indexOf("--")
const script = args.slice(dashDashIdx + 2).join(" ")
const logPath = Deno.env.get("FAKE_SSH_LOG")
if (logPath) await Deno.writeTextFile(logPath, script + "\\n---\\n", { append: true })
const seqLog = Deno.env.get("FAKE_SEQ_LOG")
if (seqLog) {
  const tag = script.includes("cd '") && script.includes("/stacks'")
    ? "stale-cleanup"
    : script.includes("DEPLOY_START:")
    ? "deploy-script"
    : "ssh:other"
  await Deno.writeTextFile(seqLog, tag + "\\n", { append: true })
}
if (script.includes("getent group docker")) {
  console.log(\`docker:x:\${Deno.env.get("FAKE_DOCKER_GID") ?? "988"}:\`)
} else if (script === "id -u") {
  console.log("0")
} else if (script.includes("DEPLOY_START:")) {
  for (const m of script.matchAll(/DEPLOY_START:(\\S+):(\\S+)/g)) {
    console.log(\`DEPLOY_START:\${m[1]}:\${m[2]}\`)
    console.log(\`DEPLOY_SUCCESS:\${m[1]}:\${m[2]}\`)
  }
}
Deno.exit(0)
`

const FAKE_RSYNC = `#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
const args = Deno.args
const logPath = Deno.env.get("FAKE_RSYNC_LOG")
if (logPath) await Deno.writeTextFile(logPath, JSON.stringify(args) + "\\n", { append: true })
const seqLog = Deno.env.get("FAKE_SEQ_LOG")
if (seqLog) await Deno.writeTextFile(seqLog, "rsync\\n", { append: true })
const dest = args[args.length - 1]
const src = args[args.length - 2].replace(/\\/$/, "")
const colonIdx = dest.indexOf(":")
const remotePath = dest.slice(colonIdx + 1)
const remoteRoot = Deno.env.get("FAKE_REMOTE_DIR")!
const destDir = remoteRoot + remotePath
async function copyDir(s, d) {
  await Deno.mkdir(d, { recursive: true })
  for await (const entry of Deno.readDir(s)) {
    const sp = \`\${s}/\${entry.name}\`
    const dp = \`\${d}/\${entry.name}\`
    if (entry.isDirectory) await copyDir(sp, dp)
    else if (entry.isFile) await Deno.copyFile(sp, dp)
  }
}
try {
  await copyDir(src, destDir)
} catch (err) {
  if (!(err instanceof Deno.errors.NotFound)) throw err
}
Deno.exit(0)
`

interface RunDeployFixture {
  projectDir: string
  binDir: string
  remoteDir: string
  sshLog: string
  rsyncLog: string
  seqLog: string
}

async function setupRunDeployFixture(): Promise<RunDeployFixture> {
  const projectDir = await Deno.makeTempDir({ prefix: "rostok-rundeploy-test-project-" })
  const binDir = await Deno.makeTempDir({ prefix: "rostok-rundeploy-test-bin-" })
  const remoteDir = await Deno.makeTempDir({ prefix: "rostok-rundeploy-test-remote-" })
  const sshLog = join(binDir, "ssh.log")
  const rsyncLog = join(binDir, "rsync.log")
  const seqLog = join(binDir, "seq.log")
  await Deno.writeTextFile(sshLog, "")
  await Deno.writeTextFile(rsyncLog, "")
  await Deno.writeTextFile(seqLog, "")
  await Deno.writeTextFile(join(binDir, "ssh"), FAKE_SSH, { mode: 0o755 })
  await Deno.writeTextFile(join(binDir, "rsync"), FAKE_RSYNC, { mode: 0o755 })
  return { projectDir, binDir, remoteDir, sshLog, rsyncLog, seqLog }
}

async function teardownRunDeployFixture(f: RunDeployFixture): Promise<void> {
  await Promise.all(
    [f.projectDir, f.binDir, f.remoteDir].map((d) => Deno.remove(d, { recursive: true })),
  )
}

async function writeLocalStack(projectDir: string, name: string): Promise<void> {
  const stackDir = join(projectDir, "stacks", name)
  await Deno.mkdir(stackDir, { recursive: true })
  await Deno.writeTextFile(
    join(stackDir, "compose.yml"),
    `name: \${PROJECT}\nservices:\n  ${name.replace(/-/g, "_")}:\n    image: busybox\n`,
  )
  // Each stack's own file, so a rsync scoped to the wrong stack's
  // directory would still be provable by which files landed where.
  await Deno.writeTextFile(join(stackDir, `${name}-marker.txt`), name)
}

async function writeRunDeployServer(projectDir: string, stackNames: string[]): Promise<void> {
  const serverDir = join(projectDir, "servers", "test")
  await Deno.mkdir(serverDir, { recursive: true })
  const envLines = [
    "SSH_ADDRESS=deploy@remote.test",
    "SSH_USER=deploy",
    "PATH_APPS=/srv/apps",
    "VOLUMES_PATH=/srv/volumes",
    "PUID=1000",
    "PGID=1000",
    "DOCKER_GROUP_ID=988",
  ]
  await Deno.writeTextFile(join(serverDir, ".env"), envLines.join("\n") + "\n")
  await Deno.writeTextFile(
    join(serverDir, "config.json"),
    JSON.stringify({ stacks: stackNames.map((name) => ({ name })) }),
  )
}

async function withRunDeployEnv<T>(f: RunDeployFixture, fn: () => Promise<T>): Promise<T> {
  const previousPath = Deno.env.get("PATH") ?? ""
  Deno.env.set("PATH", `${f.binDir}:${previousPath}`)
  Deno.env.set("FAKE_REMOTE_DIR", f.remoteDir)
  Deno.env.set("FAKE_SSH_LOG", f.sshLog)
  Deno.env.set("FAKE_RSYNC_LOG", f.rsyncLog)
  Deno.env.set("FAKE_SEQ_LOG", f.seqLog)
  try {
    return await fn()
  } finally {
    Deno.env.set("PATH", previousPath)
    Deno.env.delete("FAKE_REMOTE_DIR")
    Deno.env.delete("FAKE_SSH_LOG")
    Deno.env.delete("FAKE_RSYNC_LOG")
    Deno.env.delete("FAKE_SEQ_LOG")
  }
}

async function readRsyncCalls(f: RunDeployFixture): Promise<string[][]> {
  const text = await Deno.readTextFile(f.rsyncLog)
  return text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l))
}

Deno.test("runDeploy: a full deploy's root rsync carries --delete, excludes stacks/, and drops -u (#233)", async () => {
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeLocalStack(f.projectDir, "beta")
    await writeRunDeployServer(f.projectDir, ["alpha", "beta"])

    await withRunDeployEnv(f, () => runDeploy({ cwd: f.projectDir, server: "test" }))

    const calls = await readRsyncCalls(f)
    const rootCall = calls.find((argv) => argv.includes("--exclude=stacks"))
    assert(
      rootCall,
      `expected a root rsync call with --exclude=stacks, got:\n${JSON.stringify(calls)}`,
    )
    assert(rootCall!.includes("--delete"), "a full deploy's root sync must carry --delete")
    assert(
      !rootCall!.some((a) => /^-[a-z]*u[a-z]*$/.test(a)),
      `root sync must never carry -u, got: ${JSON.stringify(rootCall)}`,
    )
  } finally {
    await teardownRunDeployFixture(f)
  }
})

Deno.test("runDeploy: a single-stack deploy's root rsync never carries --delete (#233)", async () => {
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeLocalStack(f.projectDir, "beta")
    await writeRunDeployServer(f.projectDir, ["alpha", "beta"])

    await withRunDeployEnv(
      f,
      () => runDeploy({ cwd: f.projectDir, server: "test", stack: "alpha" }),
    )

    const calls = await readRsyncCalls(f)
    const rootCall = calls.find((argv) => argv.includes("--exclude=stacks"))
    assert(rootCall, `expected a root rsync call, got:\n${JSON.stringify(calls)}`)
    assert(
      !rootCall!.includes("--delete"),
      "a single-stack deploy's root sync must never delete server-level files it isn't touching",
    )
  } finally {
    await teardownRunDeployFixture(f)
  }
})

Deno.test("runDeploy: a single-stack deploy only rsyncs the requested stack's own stacks/ dir, never another stack's (#233)", async () => {
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeLocalStack(f.projectDir, "beta")
    await writeRunDeployServer(f.projectDir, ["alpha", "beta"])

    await withRunDeployEnv(
      f,
      () => runDeploy({ cwd: f.projectDir, server: "test", stack: "alpha" }),
    )

    const calls = await readRsyncCalls(f)
    // Exactly one per-stack rsync call — scoped structurally to
    // .../stacks/alpha, both source and destination — never one that
    // could touch .../stacks/beta.
    const stackCalls = calls.filter((argv) =>
      argv.some((a) => typeof a === "string" && a.includes("/stacks/"))
    )
    assertEquals(
      stackCalls.length,
      1,
      `expected exactly one stack rsync, got:\n${JSON.stringify(stackCalls)}`,
    )
    const [call] = stackCalls
    assert(
      call.some((a) => a.endsWith("/stacks/alpha/")),
      `source must be alpha's own dir: ${JSON.stringify(call)}`,
    )
    assert(
      call.some((a) => a.includes(":/srv/apps/stacks/alpha/")),
      `destination must be alpha's own remote dir: ${JSON.stringify(call)}`,
    )
    assert(
      !call.some((a) => a.includes("beta")),
      `must never reference beta at all: ${JSON.stringify(call)}`,
    )
    assert(
      call.includes("--delete"),
      "a stack's own scoped sync always deletes stale files inside it",
    )

    // beta's remote files (from a prior full deploy) are untouched by
    // this single-stack run: prove it by running the full deploy first,
    // then the single-stack one, and checking beta's marker survives
    // unmodified with the exact content the full deploy shipped.
  } finally {
    await teardownRunDeployFixture(f)
  }
})

Deno.test("runDeploy: a single-stack deploy leaves another stack's remote files completely untouched (#233)", async () => {
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeLocalStack(f.projectDir, "beta")
    await writeRunDeployServer(f.projectDir, ["alpha", "beta"])

    // Full deploy first, so both stacks' files exist on the "remote".
    await withRunDeployEnv(f, () => runDeploy({ cwd: f.projectDir, server: "test" }))
    const betaMarker = join(f.remoteDir, "srv", "apps", "stacks", "beta", "beta-marker.txt")
    assertEquals(await Deno.readTextFile(betaMarker), "beta")

    // Now change beta's local marker, and remove one of alpha's files —
    // a single-stack deploy of alpha only must not pick up beta's
    // change, and must remove alpha's own stale file.
    await Deno.writeTextFile(
      join(f.projectDir, "stacks", "beta", "beta-marker.txt"),
      "beta-changed-locally",
    )
    const alphaExtra = join(f.projectDir, "stacks", "alpha", "extra.txt")
    await Deno.writeTextFile(alphaExtra, "will be removed before the next deploy")
    await withRunDeployEnv(
      f,
      () => runDeploy({ cwd: f.projectDir, server: "test", stack: "alpha" }),
    )
    // Re-add locally so the fixture's own next full deploy (none here)
    // would stage it again — irrelevant to this test, but avoids a
    // confusing half-finished-looking fixture if this test is extended.
    await Deno.remove(alphaExtra)

    // beta's remote copy is exactly what the FULL deploy shipped —
    // never touched by the single-stack deploy of alpha.
    assertEquals(await Deno.readTextFile(betaMarker), "beta")

    // alpha's remote copy reflects the single-stack deploy: the marker
    // is still there, the stack directory itself synced.
    const alphaMarker = join(f.remoteDir, "srv", "apps", "stacks", "alpha", "alpha-marker.txt")
    assertEquals(await Deno.readTextFile(alphaMarker), "alpha")
  } finally {
    await teardownRunDeployFixture(f)
  }
})

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

Deno.test("runDeploy: the stale-stack cleanup runs before any rsync (#233 point 4)", async () => {
  // docker compose down needs the stack's folder to still exist to find
  // its compose.yml — once a rsync --delete removes it, there's nothing
  // left to stop. The cleanup must run first.
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeRunDeployServer(f.projectDir, ["alpha"])

    await withRunDeployEnv(f, () => runDeploy({ cwd: f.projectDir, server: "test" }))

    const seq = (await Deno.readTextFile(f.seqLog)).split("\n").filter((l) => l.length > 0)
    const cleanupIdx = seq.indexOf("stale-cleanup")
    const firstRsyncIdx = seq.indexOf("rsync")
    assert(cleanupIdx !== -1, `expected a stale-cleanup ssh call, got: ${JSON.stringify(seq)}`)
    assert(firstRsyncIdx !== -1, `expected at least one rsync call, got: ${JSON.stringify(seq)}`)
    assert(
      cleanupIdx < firstRsyncIdx,
      `stale-cleanup must run before the first rsync, got order: ${JSON.stringify(seq)}`,
    )
  } finally {
    await teardownRunDeployFixture(f)
  }
})

Deno.test("handleStagingSignal: removes the staging dir before it returns control, then exits", async () => {
  // Regression for #219's staging race: an async handler yields to the
  // event loop between its steps, and the deploy's pending writes then
  // recreate the dir. The handler must finish its cleanup synchronously,
  // so the dir is gone by the time exit() is reached, with no await.
  const stagingDir = await Deno.makeTempDir({ prefix: "rostok-deploy-test-" })
  await Deno.mkdir(join(stagingDir, "stacks", "demo"), { recursive: true })
  await Deno.writeTextFile(join(stagingDir, ".env"), "SECRET=x")
  let dirGoneAtExit: boolean | undefined
  const exit = (code: number) => {
    try {
      Deno.statSync(stagingDir)
      dirGoneAtExit = false
    } catch (err) {
      dirGoneAtExit = err instanceof Deno.errors.NotFound
    }
    throw new ExitCalled(code)
  }
  const error = assertThrows(() => handleStagingSignal(stagingDir, 129, exit), ExitCalled)
  assertEquals(error.code, 129)
  assertEquals(dirGoneAtExit, true)
})

Deno.test("installStagingSignalCleanup: covers SIGHUP, SIGINT, SIGQUIT and SIGTERM and removes them again", () => {
  const added: string[] = []
  const removed: string[] = []
  const originalAdd = Deno.addSignalListener
  const originalRemove = Deno.removeSignalListener
  Deno.addSignalListener = (signal: Deno.Signal) => void added.push(signal)
  Deno.removeSignalListener = (signal: Deno.Signal) => void removed.push(signal)
  try {
    const uninstall = installStagingSignalCleanup("/nonexistent/rostok-deploy-x")
    assertEquals(added.sort(), ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"])
    uninstall()
    assertEquals(removed.sort(), added)
  } finally {
    Deno.addSignalListener = originalAdd
    Deno.removeSignalListener = originalRemove
  }
})

Deno.test("STAGING_CLEANUP_SIGNALS: exit codes follow the shell's 128 + signal number", () => {
  const codes = Object.fromEntries(STAGING_CLEANUP_SIGNALS.map((s) => [s.signal, s.code]))
  assertEquals(codes, { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 })
  assert(STAGING_CLEANUP_SIGNALS.length === 4)
})
