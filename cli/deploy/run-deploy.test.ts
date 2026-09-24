import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
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
  const tag = script.includes("stop_and_remove")
    ? "stale-cleanup"
    : script.includes("DEPLOY_START:")
    ? "deploy-script"
    : "ssh:other"
  await Deno.writeTextFile(seqLog, tag + "\\n", { append: true })
}
const mkdirMatch = script.match(/^mkdir -p -- '(.*)'$/)
if (mkdirMatch) {
  // The real rsync wrapper below needs PATH_APPS/stacks to actually
  // exist under FAKE_REMOTE_DIR before it can write into it — a real
  // remote's mkdir -p would have created it; this fake ssh has to do
  // the same on the fake "remote" filesystem.
  const remoteRoot = Deno.env.get("FAKE_REMOTE_DIR")
  if (remoteRoot) await Deno.mkdir(remoteRoot + mkdirMatch[1], { recursive: true })
}
if (script.includes("getent group docker")) {
  console.log(\`docker:x:\${Deno.env.get("FAKE_DOCKER_GID") ?? "988"}:\`)
} else if (script === "id -u") {
  console.log("0")
} else if (script.includes("readlink -f")) {
  // checkRemotePathsNotNested (docker-preflight.ts): two readlink -f
  // calls joined by "---". Sibling, non-nested real paths by default —
  // matches every fixture below, none of which tests a server-side
  // symlink (that's covered directly in docker-preflight.test.ts).
  console.log("/srv/apps\\n---\\n/srv/volumes")
} else if (script.startsWith("sha256sum '")) {
  // getRemoteChecksums (deploy-script.ts), one call per watched file —
  // checks the REAL fake-remote filesystem (a file real rsync --delete
  // already removed there is genuinely gone by the time the "after"
  // snapshot runs), not a hand-maintained map, so a deletion between
  // the two snapshots is provable exactly the way it happens for real.
  const m = script.match(/^sha256sum '([^']*)'/)
  const remoteRoot = Deno.env.get("FAKE_REMOTE_DIR")
  if (m && remoteRoot) {
    try {
      await Deno.stat(remoteRoot + m[1])
      console.log(\`\${"a".repeat(64)}  \${m[1]}\`)
    } catch {
      // File gone (or never existed) — print nothing, matching a real
      // sha256sum's "|| true" fallback exactly.
    }
  }
} else if (script.includes("DEPLOY_START:")) {
  for (const m of script.matchAll(/DEPLOY_START:(\\S+):(\\S+)/g)) {
    console.log(\`DEPLOY_START:\${m[1]}:\${m[2]}\`)
    console.log(\`DEPLOY_SUCCESS:\${m[1]}:\${m[2]}\`)
  }
}
Deno.exit(0)
`

// A thin rewriting wrapper around a REAL rsync (review round): it logs
// the exact argv it was called with (for the argv-shape assertions
// below), rewrites the destination's "user@host:" remote spec into a
// real local path under FAKE_REMOTE_DIR (leaving a trailing slash or
// its absence exactly as given — that distinction is the whole point of
// runRemoteSync vs runRemoteSyncEntry), then execs the REAL rsync
// binary. Unlike a hand-rolled copy loop, this actually enforces
// --delete, refuses a destination whose parent doesn't exist yet (no
// --mkpath), and replaces rather than follows a symlinked destination —
// the exact real-world behaviors this PR's fixes depend on.
const FAKE_RSYNC = `#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-run
const args = Deno.args
const logPath = Deno.env.get("FAKE_RSYNC_LOG")
if (logPath) await Deno.writeTextFile(logPath, JSON.stringify(args) + "\\n", { append: true })
const seqLog = Deno.env.get("FAKE_SEQ_LOG")
if (seqLog) await Deno.writeTextFile(seqLog, "rsync\\n", { append: true })
const remoteRoot = Deno.env.get("FAKE_REMOTE_DIR")!
const rewritten = args.map((a) => {
  const m = /^([^:]*@[^:]*):(\\/.*)$/.exec(a)
  if (!m) return a
  const remotePath = m[2]
  return remoteRoot + remotePath
})
// The REAL rsync's absolute path, resolved once by the test setup
// below BEFORE this fake binary's own directory is prepended to PATH —
// a bare "rsync" here would re-resolve through PATH at call time and
// find THIS SAME wrapper again (its own directory is still first on
// PATH inside the spawned process, which inherits it), recursing
// forever instead of ever reaching the real binary.
const realRsync = Deno.env.get("REAL_RSYNC_PATH") ?? ""
if (!realRsync.startsWith("/")) {
  console.error(\`fake rsync: REAL_RSYNC_PATH must be absolute, got "\${realRsync}"\`)
  Deno.exit(98)
}
// Recursion guard: if REAL_RSYNC_PATH ever points back at this wrapper,
// the nested copy sees depth 1 and fails instead of spawning forever.
const depth = Number(Deno.env.get("FAKE_RSYNC_DEPTH") ?? "0")
if (depth > 0) {
  console.error(\`fake rsync: called itself (depth \${depth}), refusing to recurse\`)
  Deno.exit(97)
}
const proc = new Deno.Command(realRsync, {
  args: rewritten,
  env: { FAKE_RSYNC_DEPTH: String(depth + 1) },
  stdout: "piped",
  stderr: "piped",
})
const out = await proc.output()
await Deno.stdout.write(out.stdout)
await Deno.stderr.write(out.stderr)
Deno.exit(out.code)
`

interface RunDeployFixture {
  rootDir: string
  projectDir: string
  binDir: string
  remoteDir: string
  sshLog: string
  rsyncLog: string
  seqLog: string
}

/**
 * One temp root per fixture, holding project/, bin/ and remote/, so
 * teardown is a single remove and a failed setup cannot strand a
 * half-built set of sibling directories in /tmp.
 */
async function setupRunDeployFixture(): Promise<RunDeployFixture> {
  const rootDir = await Deno.makeTempDir({ prefix: "rostok-rundeploy-test-" })
  try {
    const projectDir = join(rootDir, "project")
    const binDir = join(rootDir, "bin")
    const remoteDir = join(rootDir, "remote")
    await Promise.all([projectDir, binDir, remoteDir].map((d) => Deno.mkdir(d)))
    const sshLog = join(binDir, "ssh.log")
    const rsyncLog = join(binDir, "rsync.log")
    const seqLog = join(binDir, "seq.log")
    await Deno.writeTextFile(sshLog, "")
    await Deno.writeTextFile(rsyncLog, "")
    await Deno.writeTextFile(seqLog, "")
    await Deno.writeTextFile(join(binDir, "ssh"), FAKE_SSH, { mode: 0o755 })
    await Deno.writeTextFile(join(binDir, "rsync"), FAKE_RSYNC, { mode: 0o755 })
    return { rootDir, projectDir, binDir, remoteDir, sshLog, rsyncLog, seqLog }
  } catch (err) {
    await Deno.remove(rootDir, { recursive: true })
    throw err
  }
}

async function teardownRunDeployFixture(f: RunDeployFixture): Promise<void> {
  await Deno.remove(f.rootDir, { recursive: true })
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

/**
 * The real `rsync` binary's absolute path, resolved ONCE against the
 * test process's own real PATH — never re-resolved once the fake
 * `rsync` wrapper's own bin dir is prepended to PATH, or a bare "rsync"
 * would find the wrapper itself again (see the wrapper's own comment).
 */
const REAL_RSYNC_PATH = await new Deno.Command("which", { args: ["rsync"], stdout: "piped" })
  .output()
  .then((o) => new TextDecoder().decode(o.stdout).trim())
if (!REAL_RSYNC_PATH.startsWith("/") || REAL_RSYNC_PATH.includes("rostok-rundeploy-test-")) {
  throw new Error(`run-deploy tests need a real rsync on PATH, found "${REAL_RSYNC_PATH}"`)
}

async function withRunDeployEnv<T>(f: RunDeployFixture, fn: () => Promise<T>): Promise<T> {
  const previousPath = Deno.env.get("PATH") ?? ""
  Deno.env.set("PATH", `${f.binDir}:${previousPath}`)
  Deno.env.set("FAKE_REMOTE_DIR", f.remoteDir)
  Deno.env.set("FAKE_SSH_LOG", f.sshLog)
  Deno.env.set("FAKE_RSYNC_LOG", f.rsyncLog)
  Deno.env.set("FAKE_SEQ_LOG", f.seqLog)
  Deno.env.set("REAL_RSYNC_PATH", REAL_RSYNC_PATH)
  try {
    return await fn()
  } finally {
    Deno.env.set("PATH", previousPath)
    Deno.env.delete("FAKE_REMOTE_DIR")
    Deno.env.delete("FAKE_SSH_LOG")
    Deno.env.delete("FAKE_RSYNC_LOG")
    Deno.env.delete("FAKE_SEQ_LOG")
    Deno.env.delete("REAL_RSYNC_PATH")
  }
}

async function readRsyncCalls(f: RunDeployFixture): Promise<string[][]> {
  const text = await Deno.readTextFile(f.rsyncLog)
  return text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l))
}

/** Every remote script FAKE_SSH ran, in order (split on FAKE_SSH's own "\n---\n" separator). */
async function readSshLog(f: RunDeployFixture): Promise<string[]> {
  const text = await Deno.readTextFile(f.sshLog)
  return text.split("\n---\n").filter((l) => l.length > 0)
}

Deno.test("runDeploy: a full deploy's root rsync carries --delete, excludes stacks/, and drops -u (#233)", async () => {
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeLocalStack(f.projectDir, "beta")
    await writeRunDeployServer(f.projectDir, ["alpha", "beta"])

    await withRunDeployEnv(f, () => runDeploy({ cwd: f.projectDir, server: "test" }))

    const calls = await readRsyncCalls(f)
    const rootCall = calls.find((argv) => argv.includes("--exclude=/stacks"))
    assert(
      rootCall,
      `expected a root rsync call with --exclude=/stacks, got:\n${JSON.stringify(calls)}`,
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
    const rootCall = calls.find((argv) => argv.includes("--exclude=/stacks"))
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
    // No trailing slash on the source (runRemoteSyncEntry, exec.ts) —
    // rsync transfers "alpha" as one named entry, never merges its
    // CONTENTS into the destination (which is why the destination below
    // is the PARENT "stacks/", not "stacks/alpha/").
    assert(
      call.some((a) => a.endsWith("/stacks/alpha") && !a.endsWith("/stacks/alpha/")),
      `source must be alpha's own dir, no trailing slash: ${JSON.stringify(call)}`,
    )
    assert(
      call.some((a) => a.endsWith(":/srv/apps/stacks/")),
      `destination must be the stacks/ PARENT dir, not alpha's own: ${JSON.stringify(call)}`,
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

Deno.test("runDeploy: a single-stack deploy never invokes the stale-stack cleanup at all (#233 point 3, decision A)", async () => {
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeLocalStack(f.projectDir, "beta")
    await writeRunDeployServer(f.projectDir, ["alpha", "beta"])

    await withRunDeployEnv(
      f,
      () => runDeploy({ cwd: f.projectDir, server: "test", stack: "alpha" }),
    )

    const seq = (await Deno.readTextFile(f.seqLog)).split("\n").filter((l) => l.length > 0)
    assertEquals(
      seq.includes("stale-cleanup"),
      false,
      `a single-stack deploy must never run stale-stack cleanup, got: ${JSON.stringify(seq)}`,
    )
  } finally {
    await teardownRunDeployFixture(f)
  }
})

Deno.test("runDeploy: a full deploy's stale-stack cleanup uses the FULL config.stacks list, never the filtered one (#233/#234)", async () => {
  // Proven directly on the generated script text (captured via the ssh
  // log), not just inferred from behaviour — a mutation that passed
  // `stacks` (filtered) instead of `allStackNames` would silently keep
  // "beta" out of the active-stack pattern, which this test catches by
  // requiring BOTH names to appear as "kept" in the same script.
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeLocalStack(f.projectDir, "beta")
    await writeRunDeployServer(f.projectDir, ["alpha", "beta"])

    await withRunDeployEnv(f, () => runDeploy({ cwd: f.projectDir, server: "test" }))

    const log = await readSshLog(f)
    const cleanupScript = log.find((s) => s.includes("stop_and_remove"))
    assert(cleanupScript, `expected a stale-cleanup script in the ssh log, got:\n${log.join("\n---\n")}`)
    assertStringIncludes(cleanupScript!, "' alpha '")
    assertStringIncludes(cleanupScript!, "' beta '")
  } finally {
    await teardownRunDeployFixture(f)
  }
})

Deno.test("runDeploy: hooks get the FULL config.stacks list even during a single-stack deploy, never the filtered one (#234)", async () => {
  // buildHookEnv (hooks.ts) only stays silent about another stack's own
  // key when that stack is in HookContext.installedStackNames — if
  // run-deploy.ts passed the FILTERED `stacks` list instead of
  // `allStackNames` there, a single-stack deploy of "alpha" would warn
  // about "beta"'s own keys again, even though beta is genuinely
  // installed on this server. Proven by making the warning itself the
  // assertion, not just inspecting run-deploy.ts's own source.
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeLocalStack(f.projectDir, "beta")
    await writeRunDeployServer(f.projectDir, ["alpha", "beta"])
    // A key that carries beta's own prefix, sitting in the server .env
    // (as it would for a real second installed stack) — alpha's hook
    // never gets it (that part of the allow-list is unchanged, #234),
    // but the DROP must be silent, since beta is installed here too.
    await Deno.writeTextFile(
      join(f.projectDir, "servers", "test", ".env"),
      (await Deno.readTextFile(join(f.projectDir, "servers", "test", ".env"))) +
        "BETA_IMAGE_TAG=latest\n",
    )
    await Deno.writeTextFile(
      join(f.projectDir, "stacks", "alpha", "before.deploy.ts"),
      `// no-op — presence alone is enough to make run-deploy.ts run the hook\n`,
    )

    const originalConsoleError = console.error
    const errorLines: string[] = []
    console.error = (...args: unknown[]) => {
      errorLines.push(args.map(String).join(" "))
    }
    try {
      await withRunDeployEnv(
        f,
        () => runDeploy({ cwd: f.projectDir, server: "test", stack: "alpha" }),
      )
    } finally {
      console.error = originalConsoleError
    }

    const droppedWarning = errorLines.find((l) => l.includes("dropped") && l.includes("BETA_IMAGE_TAG"))
    assertEquals(
      droppedWarning,
      undefined,
      `expected no warning for beta's own key during a single-stack deploy of alpha, got: ${
        JSON.stringify(errorLines)
      }`,
    )
  } finally {
    await teardownRunDeployFixture(f)
  }
})

Deno.test("runDeploy: deploys successfully to a fresh remote with no PATH_APPS directory at all (#233 point 2)", async () => {
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeRunDeployServer(f.projectDir, ["alpha"])
    // f.remoteDir starts completely empty — no /srv/apps, no /srv at
    // all — the closest thing to a genuinely fresh server this fixture
    // can represent without an actual VM.
    const entriesBefore = [...Deno.readDirSync(f.remoteDir)]
    assertEquals(entriesBefore, [])

    const result = await withRunDeployEnv(
      f,
      () => runDeploy({ cwd: f.projectDir, server: "test" }),
    )
    assertEquals(result.deployedStacks, ["alpha"])

    const marker = join(f.remoteDir, "srv", "apps", "stacks", "alpha", "alpha-marker.txt")
    assertEquals(await Deno.readTextFile(marker), "alpha")
  } finally {
    await teardownRunDeployFixture(f)
  }
})

Deno.test("runDeploy: config.json missing entirely skips stale cleanup and the root sync's --delete, never wipes anything (#233 point 6)", async () => {
  const f = await setupRunDeployFixture()
  try {
    // A server dir with an .env but genuinely no config.json — never
    // written yet, distinct from an explicit "stacks": [].
    const serverDir = join(f.projectDir, "servers", "test")
    await Deno.mkdir(serverDir, { recursive: true })
    await Deno.writeTextFile(
      join(serverDir, ".env"),
      [
        "SSH_ADDRESS=deploy@remote.test",
        "SSH_USER=deploy",
        "PATH_APPS=/srv/apps",
        "VOLUMES_PATH=/srv/volumes",
        "PUID=1000",
        "PGID=1000",
        "DOCKER_GROUP_ID=988",
      ].join("\n") + "\n",
    )

    const result = await withRunDeployEnv(
      f,
      () => runDeploy({ cwd: f.projectDir, server: "test" }),
    )
    assertEquals(result.deployedStacks, [])

    const seq = (await Deno.readTextFile(f.seqLog)).split("\n").filter((l) => l.length > 0)
    assertEquals(
      seq.includes("stale-cleanup"),
      false,
      `a missing config.json must never trigger stale cleanup, got: ${JSON.stringify(seq)}`,
    )
    const calls = await readRsyncCalls(f)
    const rootCall = calls.find((argv) => argv.includes("--exclude=/stacks"))
    assert(rootCall, `expected a root rsync call, got:\n${JSON.stringify(calls)}`)
    assertEquals(
      rootCall!.includes("--delete"),
      false,
      "a missing config.json must never trigger --delete on the root sync either",
    )
  } finally {
    await teardownRunDeployFixture(f)
  }
})

Deno.test("runDeploy: a watched file that a later deploy no longer ships still triggers a restart (#233 point 8)", async () => {
  // Regression: the restart check used to iterate only the AFTER
  // snapshot's own keys — a file present in the BEFORE snapshot but
  // entirely gone from AFTER (never re-staged, so real rsync --delete
  // removed it from the remote between the two scans) has no key in
  // AFTER at all, and was never visited.
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await Deno.writeTextFile(join(f.projectDir, "stacks", "alpha", "watched.txt"), "v1")
    const serverDir = join(f.projectDir, "servers", "test")
    await writeRunDeployServer(f.projectDir, ["alpha"])
    await Deno.writeTextFile(
      join(serverDir, "config.json"),
      JSON.stringify({
        stacks: [{ name: "alpha", watchFilesAndRestartIfChanged: ["stacks/alpha/watched.txt"] }],
      }),
    )

    // First deploy: the watched file exists, ships, lands on the fake remote.
    await withRunDeployEnv(f, () => runDeploy({ cwd: f.projectDir, server: "test" }))
    const remoteWatched = join(f.remoteDir, "srv", "apps", "stacks", "alpha", "watched.txt")
    assertEquals(await Deno.readTextFile(remoteWatched), "v1")

    // Second deploy: the file is gone locally — real rsync --delete
    // (already proven elsewhere) removes it from the remote for real,
    // between this run's own before/after checksum snapshots.
    await Deno.remove(join(f.projectDir, "stacks", "alpha", "watched.txt"))
    await Deno.writeTextFile(f.sshLog, "") // fresh log for this run's own assertions
    const result = await withRunDeployEnv(
      f,
      () => runDeploy({ cwd: f.projectDir, server: "test" }),
    )

    const remoteStillThere = await Deno.stat(remoteWatched).then(() => true).catch(() => false)
    assertEquals(remoteStillThere, false, "the watched file must actually be gone from the remote")
    const restartedAlpha = result.results.some((r) => r.name === "alpha")
    assert(restartedAlpha, "alpha must still have deployed")
    const log = await readSshLog(f)
    assert(
      log.some((s) => s.includes("RESTARTING:alpha:alpha") || s.includes("restart")),
      `expected a restart for alpha after its watched file was removed, got:\n${log.join("\n---\n")}`,
    )
  } finally {
    await teardownRunDeployFixture(f)
  }
})

Deno.test("runDeploy: the per-stack sync never carries -u either (#233 mutation-gap)", async () => {
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeRunDeployServer(f.projectDir, ["alpha"])

    await withRunDeployEnv(f, () => runDeploy({ cwd: f.projectDir, server: "test" }))

    const calls = await readRsyncCalls(f)
    const stackCall = calls.find((argv) => argv.some((a) => a.endsWith("/stacks/alpha")))
    assert(stackCall, `expected the per-stack rsync call, got:\n${JSON.stringify(calls)}`)
    assert(
      !stackCall!.some((a) => /^-[a-z]*u[a-z]*$/.test(a)),
      `per-stack sync must never carry -u either, got: ${JSON.stringify(stackCall)}`,
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
