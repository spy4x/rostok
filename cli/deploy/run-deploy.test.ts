import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert"
import { dirname, join } from "@std/path"
import {
  handleStagingSignal,
  installStagingSignalCleanup,
  runDeploy,
  type RunDeployIO,
  STAGING_CLEANUP_SIGNALS,
} from "./run-deploy.ts"
import type { CommandResult } from "./exec.ts"
import { UserError } from "../errors.ts"

// #233 review: an earlier version of this file faked `ssh`/`rsync` as
// PATH binaries — a fake `rsync` recursed into itself through a PATH
// lookup and spawned ~4,900 processes (73 GB RAM, load 1,100) on the
// dev box. No test in this file spawns any process at all now:
// `runDeploy` takes an injectable `RunDeployIO` (run-deploy.ts), and
// every fake below is a plain in-process TypeScript object that
// records calls and does its own file I/O directly through Deno's fs
// APIs — never a subprocess, never a name resolved through PATH.

function ok(output = ""): CommandResult {
  return { success: true, code: 0, output, error: "" }
}

/** A real temp directory standing in for the "remote" filesystem, plus the call log the fakes below record into. */
interface FakeRemote {
  root: string
  /** Every IO call, in order: "docker-group" | "sudo" | "readlink" | "mkdir" | "stale-cleanup" | "rsync:root" | "rsync:entry:<name>" | "checksums" | "network" | "deploy-script". */
  calls: string[]
  /** Every runRemoteShell script, in the order it ran. */
  shellScripts: string[]
  rsyncCalls: { entry: boolean; src: string; destParent: string; flags: string[] }[]
  failStaleCleanup?: boolean
  /** Stdout the stale-stack cleanup script "prints" on the remote. */
  staleCleanupOutput?: string
  /** Stderr of a failed stale-stack cleanup (default: a fixed message). */
  staleCleanupError?: string
  /** What needsRemoteSudo answers (default false: the remote user is root). */
  remoteNeedsSudo?: boolean
  /** The needsSudo value runDeploy handed to checkRemotePathsNotNested. */
  pathsCheckSudo?: boolean
  failDeployStack?: string
}

/**
 * Copy `src` into `destParent` the way `runRemoteSync`/`runRemoteSyncEntry`
 * copy onto a real remote — CONTENTS-merge (root sync) or AS ONE NAMED
 * ENTRY (per-stack sync), matching the trailing-slash distinction those
 * two functions encode in their own argv (exec.ts). Fails, the same
 * way a real rsync does, when `destParent` doesn't already exist (no
 * `--mkpath`) — the fresh-server tests below rely on this to prove the
 * explicit `mkdir -p` call actually matters.
 */
async function copyEntry(
  src: string,
  destParent: string,
  entry: boolean,
  excludeStacks: boolean,
): Promise<CommandResult> {
  const parentExists = await Deno.stat(destParent).then((s) => s.isDirectory).catch(() => false)
  if (!parentExists) {
    return {
      success: false,
      code: 11,
      output: "",
      error: `mkdir "${destParent}" failed: No such file or directory`,
    }
  }
  if (entry) {
    const base = src.split("/").filter((p) => p.length > 0).pop()!
    const dest = join(destParent, base)
    await Deno.remove(dest, { recursive: true }).catch(() => {})
    await copyRecursive(src, dest)
  } else {
    for await (const e of Deno.readDir(src)) {
      if (excludeStacks && e.name === "stacks") continue
      await copyRecursive(join(src, e.name), join(destParent, e.name))
    }
  }
  return ok()
}

async function copyRecursive(src: string, dest: string): Promise<void> {
  const info = await Deno.stat(src)
  if (info.isDirectory) {
    await Deno.mkdir(dest, { recursive: true })
    for await (const e of Deno.readDir(src)) {
      await copyRecursive(join(src, e.name), join(dest, e.name))
    }
  } else {
    await Deno.mkdir(dirname(dest), { recursive: true })
    await Deno.copyFile(src, dest)
  }
}

/** Build a `RunDeployIO` whose every method is a plain in-process function — see the module comment. */
function makeFakeIO(remote: FakeRemote): RunDeployIO {
  return {
    checkDockerGroup: async () => {
      remote.calls.push("docker-group")
    },
    needsRemoteSudo: async () => {
      remote.calls.push("sudo")
      return remote.remoteNeedsSudo ?? false
    },
    checkRemotePathsNotNested: async (_address, _pathApps, _volumesPath, needsSudo) => {
      remote.calls.push("readlink")
      remote.pathsCheckSudo = needsSudo
    },
    runRemoteShell: async (_address: string, script: string) => {
      remote.shellScripts.push(script)
      const mkdirMatch = script.match(/^mkdir -p -- '(.*)'$/)
      if (mkdirMatch) {
        remote.calls.push("mkdir")
        await Deno.mkdir(remote.root + mkdirMatch[1], { recursive: true })
        return ok()
      }
      if (script.includes("stop_and_remove")) {
        remote.calls.push("stale-cleanup")
        const output = remote.staleCleanupOutput ?? ""
        if (remote.failStaleCleanup) {
          return {
            success: false,
            code: 1,
            output,
            error: remote.staleCleanupError ?? "simulated stale-cleanup failure",
          }
        }
        return ok(output)
      }
      const shaMatch = script.match(/^sha256sum '([^']*)'/)
      if (shaMatch) {
        remote.calls.push("checksums")
        const exists = await Deno.stat(remote.root + shaMatch[1]).then(() => true).catch(() =>
          false
        )
        return ok(exists ? `${"a".repeat(64)}  ${shaMatch[1]}` : "")
      }
      if (script.includes("docker network inspect proxy")) {
        remote.calls.push("network")
        return ok()
      }
      if (script.includes("DEPLOY_START:")) {
        remote.calls.push("deploy-script")
        const lines: string[] = []
        for (const m of script.matchAll(/DEPLOY_START:(\S+):(\S+)/g)) {
          lines.push(`DEPLOY_START:${m[1]}:${m[2]}`)
          if (m[1] === remote.failDeployStack) {
            lines.push("simulated docker compose failure")
            lines.push(`DEPLOY_FAILED:${m[1]}:${m[2]}`)
          } else {
            lines.push(`DEPLOY_SUCCESS:${m[1]}:${m[2]}`)
          }
        }
        return ok(lines.join("\n"))
      }
      // Volume mkdir/chown script, or anything else this fixture
      // doesn't need to distinguish — a healthy remote just succeeds.
      return ok()
    },
    runRemoteSync: async (
      _address: string,
      localDir: string,
      remotePath: string,
      extraArgs = [],
    ) => {
      remote.calls.push("rsync:root")
      const destParent = remote.root + remotePath
      remote.rsyncCalls.push({ entry: false, src: localDir, destParent, flags: extraArgs })
      return await copyEntry(localDir, destParent, false, extraArgs.includes("--exclude=/stacks"))
    },
    runRemoteSyncEntry: async (
      _address: string,
      localEntryDir: string,
      remoteParentPath: string,
      extraArgs = [],
    ) => {
      const name = localEntryDir.split("/").filter((p) => p.length > 0).pop()!
      remote.calls.push(`rsync:entry:${name}`)
      const destParent = remote.root + remoteParentPath
      remote.rsyncCalls.push({ entry: true, src: localEntryDir, destParent, flags: extraArgs })
      return await copyEntry(localEntryDir, destParent, true, false)
    },
    getRemoteChecksums: async (_address: string, pathApps: string, files: string[]) => {
      const map = new Map<string, string>()
      for (const f of files) {
        const exists = await Deno.stat(join(remote.root + pathApps, f)).then(() => true).catch(
          () => false,
        )
        if (exists) map.set(f, "a".repeat(64))
      }
      return map
    },
  }
}

interface RunDeployFixture {
  projectDir: string
  remote: FakeRemote
  io: RunDeployIO
}

async function setupRunDeployFixture(): Promise<RunDeployFixture> {
  const projectDir = await Deno.makeTempDir({ prefix: "rostok-rundeploy-test-project-" })
  const root = await Deno.makeTempDir({ prefix: "rostok-rundeploy-test-remote-" })
  const remote: FakeRemote = { root, calls: [], shellScripts: [], rsyncCalls: [] }
  return { projectDir, remote, io: makeFakeIO(remote) }
}

async function teardownRunDeployFixture(f: RunDeployFixture): Promise<void> {
  await Deno.remove(f.projectDir, { recursive: true })
  await Deno.remove(f.remote.root, { recursive: true })
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

Deno.test("runDeploy: a full deploy's root rsync carries --delete, excludes /stacks, and drops -u (#233)", async () => {
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeLocalStack(f.projectDir, "beta")
    await writeRunDeployServer(f.projectDir, ["alpha", "beta"])

    await runDeploy({ cwd: f.projectDir, server: "test" }, f.io)

    const rootCall = f.remote.rsyncCalls.find((c) => !c.entry)
    assert(rootCall, `expected a root rsync call, got:\n${JSON.stringify(f.remote.rsyncCalls)}`)
    assert(rootCall!.flags.includes("--exclude=/stacks"), JSON.stringify(rootCall))
    assert(rootCall!.flags.includes("--delete"), "a full deploy's root sync must carry --delete")
    assert(
      !rootCall!.flags.some((a) => /^-[a-z]*u[a-z]*$/.test(a)),
      `root sync must never carry -u, got: ${JSON.stringify(rootCall!.flags)}`,
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

    await runDeploy({ cwd: f.projectDir, server: "test", stack: "alpha" }, f.io)

    const rootCall = f.remote.rsyncCalls.find((c) => !c.entry)
    assert(rootCall, `expected a root rsync call, got:\n${JSON.stringify(f.remote.rsyncCalls)}`)
    assertEquals(
      rootCall!.flags.includes("--delete"),
      false,
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

    await runDeploy({ cwd: f.projectDir, server: "test", stack: "alpha" }, f.io)

    const entryCalls = f.remote.rsyncCalls.filter((c) => c.entry)
    assertEquals(
      entryCalls.length,
      1,
      `expected exactly one stack rsync, got:\n${JSON.stringify(entryCalls)}`,
    )
    const [call] = entryCalls
    // No trailing slash on the source (runRemoteSyncEntry, exec.ts) —
    // rsync transfers "alpha" as one named entry, never merges its
    // CONTENTS into the destination (which is why the destination
    // below is the PARENT "stacks", not "stacks/alpha").
    assert(call.src.endsWith("/stacks/alpha"), `source must be alpha's own dir: ${call.src}`)
    assert(
      call.destParent.endsWith("/stacks"),
      `destination must be the stacks PARENT dir, not alpha's own: ${call.destParent}`,
    )
    assert(!call.src.includes("beta"), `must never reference beta at all: ${call.src}`)
    assert(
      call.flags.includes("--delete"),
      "a stack's own scoped sync always deletes stale files inside it",
    )
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

    // Stage an extra file on alpha before the FIRST (full) deploy, so
    // it genuinely exists on the remote to begin with.
    const alphaExtra = join(f.projectDir, "stacks", "alpha", "extra.txt")
    await Deno.writeTextFile(alphaExtra, "will be removed before the next deploy")

    // Full deploy first, so both stacks' files (including alpha's extra
    // one) exist on the "remote".
    await runDeploy({ cwd: f.projectDir, server: "test" }, f.io)
    const betaMarker = join(f.remote.root, "srv", "apps", "stacks", "beta", "beta-marker.txt")
    assertEquals(await Deno.readTextFile(betaMarker), "beta")
    const alphaDir = join(f.remote.root, "srv", "apps", "stacks", "alpha")
    assertEquals(
      await Deno.readTextFile(join(alphaDir, "extra.txt")),
      "will be removed before the next deploy",
    )

    // Now change beta's local marker, and remove alpha's extra file —
    // a single-stack deploy of alpha only must not pick up beta's
    // change, and must remove alpha's own stale file via its scoped
    // --delete.
    await Deno.writeTextFile(
      join(f.projectDir, "stacks", "beta", "beta-marker.txt"),
      "beta-changed-locally",
    )
    await Deno.remove(alphaExtra)
    await runDeploy({ cwd: f.projectDir, server: "test", stack: "alpha" }, f.io)

    // beta's remote copy is exactly what the FULL deploy shipped —
    // never touched by the single-stack deploy of alpha.
    assertEquals(await Deno.readTextFile(betaMarker), "beta")

    // alpha's remote copy reflects the single-stack deploy: the marker
    // is still there, and the stale extra file is gone (--delete).
    assertEquals(await Deno.readTextFile(join(alphaDir, "alpha-marker.txt")), "alpha")
    const extraStillThere = await Deno.stat(join(alphaDir, "extra.txt")).then(() => true).catch(
      () => false,
    )
    assertEquals(extraStillThere, false, "alpha's own stale file must be gone after --delete")
  } finally {
    await teardownRunDeployFixture(f)
  }
})

Deno.test("runDeploy: calls io.checkRemotePathsNotNested before any sync (review round)", async () => {
  // Nothing else in this file asserted this call ever happens at all —
  // deleting it from run-deploy.ts stayed green under every other test
  // here, silently dropping the ONLY check that can catch a symlink an
  // attacker (or a stale mistake) put in place directly on the server
  // itself (docker-preflight.ts's own doc comment: env.ts's
  // pathsNestedOrEqual only ever sees the .env strings, never the real
  // resolved paths).
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeRunDeployServer(f.projectDir, ["alpha"])

    await runDeploy({ cwd: f.projectDir, server: "test" }, f.io)

    assert(
      f.remote.calls.includes("readlink"),
      `expected checkRemotePathsNotNested to run, got: ${JSON.stringify(f.remote.calls)}`,
    )
    const readlinkIdx = f.remote.calls.indexOf("readlink")
    const firstRsyncIdx = f.remote.calls.findIndex((c) => c.startsWith("rsync:"))
    assert(
      firstRsyncIdx === -1 || readlinkIdx < firstRsyncIdx,
      `checkRemotePathsNotNested must run before any sync, got order: ${
        JSON.stringify(f.remote.calls)
      }`,
    )
  } finally {
    await teardownRunDeployFixture(f)
  }
})

Deno.test("runDeploy: passes the remote's sudo need to the paths check, so VOLUMES_PATH is created with sudo -n", async () => {
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeRunDeployServer(f.projectDir, ["alpha"])
    f.remote.remoteNeedsSudo = true

    await runDeploy({ cwd: f.projectDir, server: "test" }, f.io)

    assertEquals(f.remote.pathsCheckSudo, true)
  } finally {
    await teardownRunDeployFixture(f)
  }
})

Deno.test("runDeploy: control characters in the stale-stack cleanup's output never reach the terminal", async () => {
  // Folder names and docker labels on the server end up in this output;
  // anyone with access there could shape them into escape sequences.
  const f = await setupRunDeployFixture()
  const logged: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => logged.push(args.map(String).join(" "))
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeRunDeployServer(f.projectDir, ["alpha"])
    f.remote.staleCleanupOutput = "skipped 'x\x1b]0;PWNED\x07\x1b[31mRED': unsafe name\n"

    await runDeploy({ cwd: f.projectDir, server: "test" }, f.io)

    const line = logged.find((l) => l.includes("unsafe name"))
    assertEquals(line, "skipped 'x]0;PWNED[31mRED': unsafe name")
  } finally {
    console.log = originalLog
    await teardownRunDeployFixture(f)
  }
})

Deno.test("runDeploy: a failed stale-stack cleanup's error message carries no control characters", async () => {
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeRunDeployServer(f.projectDir, ["alpha"])
    f.remote.failStaleCleanup = true
    f.remote.staleCleanupError = "docker: bad label 'x\x1b[2J'\n"

    const err = await assertRejects(
      () => runDeploy({ cwd: f.projectDir, server: "test" }, f.io),
      UserError,
    )
    assertStringIncludes(err.message, "docker: bad label 'x[2J'")
    assertEquals(err.message.includes("\x1b"), false, err.message)
  } finally {
    await teardownRunDeployFixture(f)
  }
})

Deno.test("runDeploy: the stale-stack cleanup runs before any rsync (#233 point 4)", async () => {
  // docker compose down needs the stack's folder to still exist to find
  // its compose.yml — once a rsync --delete removes it, there's nothing
  // left to stop. The cleanup must run first.
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeRunDeployServer(f.projectDir, ["alpha"])

    await runDeploy({ cwd: f.projectDir, server: "test" }, f.io)

    const cleanupIdx = f.remote.calls.indexOf("stale-cleanup")
    const firstRsyncIdx = f.remote.calls.findIndex((c) => c.startsWith("rsync:"))
    assert(
      cleanupIdx !== -1,
      `expected a stale-cleanup call, got: ${JSON.stringify(f.remote.calls)}`,
    )
    assert(
      firstRsyncIdx !== -1,
      `expected at least one rsync call, got: ${JSON.stringify(f.remote.calls)}`,
    )
    assert(
      cleanupIdx < firstRsyncIdx,
      `stale-cleanup must run before the first rsync, got order: ${JSON.stringify(f.remote.calls)}`,
    )
  } finally {
    await teardownRunDeployFixture(f)
  }
})

Deno.test("runDeploy: a failed stale-stack cleanup throws a UserError, never just logs and continues (review round)", async () => {
  // A stack that couldn't be stopped is still running, unmanaged — the
  // whole point of run-deploy.ts's own doc comment on this call.
  // Downgrading this to a console.error (swallowing it) would let a
  // deploy report success while a stale container never actually
  // stopped, and would still sync files right past it.
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeRunDeployServer(f.projectDir, ["alpha"])
    f.remote.failStaleCleanup = true

    const err = await assertRejects(
      () => runDeploy({ cwd: f.projectDir, server: "test" }, f.io),
      UserError,
    )
    assertStringIncludes(err.message, "failed to clean up stale stacks")
    assertStringIncludes(err.message, "simulated stale-cleanup failure")
    // The failure must stop the deploy right there — no sync after it.
    assertEquals(
      f.remote.calls.some((c) => c.startsWith("rsync:")),
      false,
      `a failed stale-cleanup must never let a sync run, got: ${JSON.stringify(f.remote.calls)}`,
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

    await runDeploy({ cwd: f.projectDir, server: "test", stack: "alpha" }, f.io)

    assertEquals(
      f.remote.calls.includes("stale-cleanup"),
      false,
      `a single-stack deploy must never run stale-stack cleanup, got: ${
        JSON.stringify(f.remote.calls)
      }`,
    )
  } finally {
    await teardownRunDeployFixture(f)
  }
})

Deno.test("runDeploy: a full deploy's stale-stack cleanup uses the FULL config.stacks list, never the filtered one (#233/#234)", async () => {
  // Proven directly on the generated script text, not just inferred
  // from behaviour — a mutation that passed `stacks` (filtered) instead
  // of `allStackNames` would silently keep "beta" out of the
  // active-stack pattern, which this test catches by requiring BOTH
  // names to appear as "kept" in the same script.
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeLocalStack(f.projectDir, "beta")
    await writeRunDeployServer(f.projectDir, ["alpha", "beta"])

    await runDeploy({ cwd: f.projectDir, server: "test" }, f.io)

    const cleanupScript = f.remote.shellScripts.find((s) => s.includes("stop_and_remove"))
    assert(
      cleanupScript,
      `expected a stale-cleanup script, got:\n${f.remote.shellScripts.join("\n---\n")}`,
    )
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
      await runDeploy({ cwd: f.projectDir, server: "test", stack: "alpha" }, f.io)
    } finally {
      console.error = originalConsoleError
    }

    const droppedWarning = errorLines.find((l) =>
      l.includes("dropped") && l.includes("BETA_IMAGE_TAG")
    )
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
    // f.remote.root starts completely empty — no /srv/apps, no /srv at
    // all — the closest thing to a genuinely fresh server this fixture
    // can represent without an actual VM.
    const entriesBefore = [...Deno.readDirSync(f.remote.root)]
    assertEquals(entriesBefore, [])

    const result = await runDeploy({ cwd: f.projectDir, server: "test" }, f.io)
    assertEquals(result.deployedStacks, ["alpha"])
    assert(f.remote.calls.includes("mkdir"), "expected an explicit mkdir -p call")

    const marker = join(f.remote.root, "srv", "apps", "stacks", "alpha", "alpha-marker.txt")
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

    const result = await runDeploy({ cwd: f.projectDir, server: "test" }, f.io)
    assertEquals(result.deployedStacks, [])

    assertEquals(
      f.remote.calls.includes("stale-cleanup"),
      false,
      `a missing config.json must never trigger stale cleanup, got: ${
        JSON.stringify(f.remote.calls)
      }`,
    )
    const rootCall = f.remote.rsyncCalls.find((c) => !c.entry)
    assert(rootCall, `expected a root rsync call, got:\n${JSON.stringify(f.remote.rsyncCalls)}`)
    assertEquals(
      rootCall!.flags.includes("--delete"),
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
  // entirely gone from AFTER (never re-staged, so this fake's own
  // --delete-equivalent replacement removed it from the remote between
  // the two scans) has no key in AFTER at all, and was never visited.
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
    await runDeploy({ cwd: f.projectDir, server: "test" }, f.io)
    const remoteWatched = join(f.remote.root, "srv", "apps", "stacks", "alpha", "watched.txt")
    assertEquals(await Deno.readTextFile(remoteWatched), "v1")

    // Second deploy: the file is gone locally — the per-stack sync's
    // own entry-replacement (rm -rf then re-copy, copyEntry above)
    // removes it from the remote for real, between this run's own
    // before/after checksum snapshots.
    await Deno.remove(join(f.projectDir, "stacks", "alpha", "watched.txt"))
    const result = await runDeploy({ cwd: f.projectDir, server: "test" }, f.io)

    const remoteStillThere = await Deno.stat(remoteWatched).then(() => true).catch(() => false)
    assertEquals(remoteStillThere, false, "the watched file must actually be gone from the remote")
    const deployedAlpha = result.results.some((r) => r.name === "alpha" && r.success)
    assert(deployedAlpha, "alpha must still have deployed successfully")

    // generateDeployScript (deploy-script.ts) only embeds a
    // "RESTARTING:<name>:<name>" block for a stack the restart-check
    // actually flagged — its presence in the SECOND deploy's own
    // generated script is the real proof a restart was requested, not
    // just that the deploy succeeded (which it would regardless).
    const deployScripts = f.remote.shellScripts.filter((s) => s.includes("DEPLOY_START:"))
    const secondDeployScript = deployScripts[deployScripts.length - 1]
    assert(secondDeployScript, "expected a second deploy-script run")
    assertStringIncludes(secondDeployScript, "RESTARTING:alpha:alpha")
  } finally {
    await teardownRunDeployFixture(f)
  }
})

Deno.test("runDeploy: the per-stack sync never carries -u either (#233 mutation-gap)", async () => {
  const f = await setupRunDeployFixture()
  try {
    await writeLocalStack(f.projectDir, "alpha")
    await writeRunDeployServer(f.projectDir, ["alpha"])

    await runDeploy({ cwd: f.projectDir, server: "test" }, f.io)

    const entryCall = f.remote.rsyncCalls.find((c) => c.entry)
    assert(
      entryCall,
      `expected the per-stack rsync call, got:\n${JSON.stringify(f.remote.rsyncCalls)}`,
    )
    assert(
      !entryCall!.flags.some((a) => /^-[a-z]*u[a-z]*$/.test(a)),
      `per-stack sync must never carry -u either, got: ${JSON.stringify(entryCall!.flags)}`,
    )
  } finally {
    await teardownRunDeployFixture(f)
  }
})

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

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
