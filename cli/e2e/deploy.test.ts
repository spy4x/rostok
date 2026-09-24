// End-to-end test for `rostok deploy` (#203 point 4).
//
// Walks the path a JSR-installed user is in: a project folder outside
// this repo, with no `stacks/` directory of its own — every stack file
// has to come from the CLI package's bundled catalog (cli/deploy/
// shipped-stacks.ts + stack-files.ts), never from `./stacks/` or
// `./scripts/`.
//
// #233 review: no test in this file spawns (or fakes) `rsync`, ever —
// an earlier fake `rsync` elsewhere in this PR recursed into itself
// through a PATH lookup and spawned ~4,900 processes (73 GB RAM, load
// 1,100) on the dev box. A test that needs files to actually reach a
// "remote" calls `runDeploy()` in-process (`cli/deploy/run-deploy.ts`)
// with an injected `RunDeployIO` (`makeFakeIO` below) — a plain
// in-process object that copies files directly through Deno's fs APIs,
// never a subprocess. A test that only needs the REAL CLI entry point
// (`cli/+main.ts`, as a real subprocess, for #211/#227's error-
// formatting wrapper) either fails before the deploy would ever reach a
// sync step, or is interrupted (SIGINT/SIGTERM/SIGHUP) before reaching
// one — `FAKE_SSH` alone (a plain POSIX `sh` script — never a `deno`
// script: the owner's rule is no fake binary may be a Deno process,
// since each spawn is a full process, and this one never re-execs
// anything by a bare name on PATH, so it can't recurse the way an
// earlier fake `rsync` elsewhere in this PR did) is enough for those; no
// `rsync` binary needs to exist on `PATH` at all for any test in this
// file — every fixture that can lose its "kill before the sync step"
// race also sets `FAKE_SSH_HANG_ON` (see runInterruptedDeploy and the
// ~1,500-file staging test) so a late signal still lands on this fake,
// harmless, never on the system's real `rsync`.
//
// If cli/deploy/shipped-stacks.ts under-lists a catalog stack's files
// (or run-deploy.ts fails to stage one), the corresponding assertion
// below fails.

import { assert, assertEquals, assertExists, assertStringIncludes } from "@std/assert"
import { dirname, join } from "@std/path"
import { runDeploy, type RunDeployIO } from "../deploy/run-deploy.ts"
import type { CommandResult } from "../deploy/exec.ts"

const FAKE_SSH = `#!/bin/sh
# Records every invocation to FAKE_SSH_LOG, then fakes just enough of a
# remote host for a deploy to complete: the docker-group + remote-UID
# preflights, the readlink -f symlink guard, and the per-stack
# DEPLOY_START/DEPLOY_SUCCESS markers the real deploy script would print
# after a successful \`docker compose up\`. Anything else (proxy network,
# stale-stack cleanup, volume mkdir/chown) is accepted silently, matching
# a healthy remote. Never calls \`ssh\`, \`rsync\` or any other name by
# looking it up on PATH — it only ever prints to its own stdout/stderr —
# so it can't recurse the way an earlier fake \`rsync\` elsewhere in this
# PR did. Plain POSIX \`sh\`, never a \`deno\` script (owner's rule: no fake
# binary may be a Deno process — each spawn is a full process).
#
# Every real call is \`ssh -o ConnectTimeout=10 [-o BatchMode=yes] [-p <port>]
# -- <target> <command...>\` (cli/deploy/exec.ts's sshArgs, see
# cli/server-keys.ts) — the target and command sit right after the first
# \`--\`, wherever the options before it land.
set -u

found_dashdash=0
skip_target=0
script=""
for a in "$@"; do
  if [ "$found_dashdash" = 1 ] && [ "$skip_target" = 1 ]; then
    if [ -z "$script" ]; then
      script=$a
    else
      script="$script $a"
    fi
  elif [ "$found_dashdash" = 1 ]; then
    skip_target=1
  elif [ "$a" = "--" ]; then
    found_dashdash=1
  fi
done

if [ -n "\${FAKE_SSH_LOG:-}" ]; then
  printf '%s\\n---\\n' "$script" >> "$FAKE_SSH_LOG"
fi

# FAKE_SSH_UNREACHABLE simulates a dead/unreachable server. A real ssh
# enforces -o ConnectTimeout=10 itself, so this fake only needs to check
# the flag is actually in argv: present -> fail immediately the way ssh
# does on a real timeout (proving the wiring works, without spending 10
# real seconds on it); ABSENT -> really hang, the way an unreachable host
# would without that flag, so a regression that drops ConnectTimeout
# turns this test red instead of quietly slow.
if [ -n "\${FAKE_SSH_UNREACHABLE:-}" ]; then
  case " $* " in
    *" ConnectTimeout=10 "*)
      echo "ssh: connect to host remote.test port 22: Connection timed out" >&2
      exit 255
      ;;
  esac
  # No ConnectTimeout in argv: really hang, the way an unreachable host
  # would, until killed — or this self-deadline (well past every test's
  # own bounded wait) fires in case deploy's own signal handling
  # regresses and never reaches this child. \`exec\` (not a plain
  # foregrounded \`sleep\`) replaces THIS shell's own process image with
  # sleep's: some shells (bash included, even in --posix/sh mode) defer
  # their own termination on a caught-by-default signal until the
  # foreground command they're waiting on finishes — a plain \`sleep 20\`
  # would silently absorb the test's SIGTERM/SIGINT/SIGHUP for the full
  # 20s instead of dying immediately. Once \`exec\`'d, there's no shell
  # left to defer anything: the pid IS sleep's own, and sleep terminates
  # on the signal's ordinary default disposition right away.
  exec sleep 20
fi

# FAKE_SSH_HANG_ON hangs forever the first time \`script\` contains this
# text — used to hold a deploy open mid-run so a test can send it a
# signal while the staging directory still exists, and needed so the
# SIGINT/SIGTERM tests below prove deploy actually KILLS this child, not
# just that it happened to already exit on its own. Same self-deadline as
# above.
if [ -n "\${FAKE_SSH_HANG_ON:-}" ]; then
  case "$script" in
    *"\${FAKE_SSH_HANG_ON}"*)
      # FAKE_SSH_PID_FILE: record this process's own pid before hanging,
      # so a test can prove deploy actually killed THIS process (not
      # just that deploy itself exited) by checking the pid is gone
      # afterward.
      if [ -n "\${FAKE_SSH_PID_FILE:-}" ]; then
        echo "$$" > "$FAKE_SSH_PID_FILE"
      fi
      # \`exec\` — see the FAKE_SSH_UNREACHABLE branch above for why a
      # plain foregrounded \`sleep\` would let a signal go unnoticed for
      # the full 20s on some shells. The pid just written is still
      # correct after \`exec\`: it never forks, it replaces this same
      # process.
      exec sleep 20
      ;;
  esac
fi

case "$script" in
  *"getent group docker"*)
    echo "docker:x:\${FAKE_DOCKER_GID:-988}:"
    ;;
  "id -u")
    # Default: root (uid 0) — matches SSH_ADDRESS=deploy@remote.test in
    # the fixtures below, which is a placeholder address, not a real
    # login.
    echo "\${FAKE_REMOTE_UID:-0}"
    ;;
  *"readlink -f"*)
    # checkRemotePathsNotNested (docker-preflight.ts, #233 + review
    # round): three readlink -f calls (PATH_APPS, VOLUMES_PATH,
    # PATH_APPS/stacks), one path per line. Sibling, non-nested real paths,
    # stacks/ resolving to PATH_APPS's own stacks dir — none of these
    # fixtures test a server-side symlink (that's covered directly in
    # docker-preflight.test.ts).
    printf '/srv/apps\\n/srv/volumes\\n/srv/apps/stacks\\n'
    ;;
  *"DEPLOY_START:"*)
    # FAKE_DEPLOY_FAIL_STACK lets a test simulate a stack whose
    # \`docker compose up\` fails on the remote — everything else about
    # the fake remote (docker group, uid) stays healthy.
    echo "$script" | grep -oE 'DEPLOY_START:[^ ]+:[^ ]+' |
    while IFS=: read -r _tag stack id; do
      echo "DEPLOY_START:$stack:$id"
      if [ "$stack" = "\${FAKE_DEPLOY_FAIL_STACK:-}" ]; then
        echo "simulated docker compose failure"
        echo "DEPLOY_FAILED:$stack:$id"
      else
        echo "DEPLOY_SUCCESS:$stack:$id"
      fi
    done
    ;;
esac
exit 0
`

interface Fixture {
  projectDir: string
  binDir: string
  remoteDir: string
  logPath: string
}

async function setupFixture(): Promise<Fixture> {
  const projectDir = await Deno.makeTempDir({ prefix: "rostok-e2e-project-" })
  const binDir = await Deno.makeTempDir({ prefix: "rostok-e2e-bin-" })
  const remoteDir = await Deno.makeTempDir({ prefix: "rostok-e2e-remote-" })
  const logPath = join(binDir, "ssh.log")

  // Only `ssh` — never `rsync` (#233 review). Every test that needs
  // files to actually reach a "remote" drives runDeploy in-process with
  // an injected RunDeployIO (makeFakeIO below) instead.
  await Deno.writeTextFile(join(binDir, "ssh"), FAKE_SSH, { mode: 0o755 })

  return { projectDir, binDir, remoteDir, logPath }
}

async function teardownFixture(f: Fixture): Promise<void> {
  await Promise.all(
    [f.projectDir, f.binDir, f.remoteDir].map((d) => Deno.remove(d, { recursive: true })),
  )
}

async function writeServer(
  projectDir: string,
  extraEnvLines: string[],
  stackNames: string[],
  opts: { omitKeys?: string[] } = {},
): Promise<void> {
  const serverDir = join(projectDir, "servers", "test")
  await Deno.mkdir(serverDir, { recursive: true })
  const omit = new Set(opts.omitKeys ?? [])
  const baseline = [
    ["SSH_ADDRESS", "deploy@remote.test"],
    ["SSH_USER", "deploy"],
    ["PATH_APPS", "/srv/apps"],
    ["VOLUMES_PATH", "/srv/volumes"],
    ["PUID", "1000"],
    ["PGID", "1000"],
    ["DOCKER_GROUP_ID", "988"],
  ]
  const envLines = [
    ...baseline.filter(([key]) => !omit.has(key)).map(([key, value]) => `${key}=${value}`),
    ...extraEnvLines,
  ]
  await Deno.writeTextFile(join(serverDir, ".env"), envLines.join("\n") + "\n")
  await Deno.writeTextFile(
    join(serverDir, "config.json"),
    JSON.stringify({ stacks: stackNames.map((name) => ({ name })) }),
  )
}

/** Write `.env.root` at the project root (the cross-server env file). */
async function writeRootEnv(projectDir: string, lines: string[]): Promise<void> {
  await Deno.writeTextFile(join(projectDir, ".env.root"), lines.join("\n") + "\n")
}

async function runDeployCli(
  f: Fixture,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ success: boolean; code: number; stdout: string; stderr: string }> {
  const mainTs = new URL("../+main.ts", import.meta.url).pathname
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", mainTs, ...args],
    cwd: f.projectDir,
    env: {
      ...Deno.env.toObject(),
      PATH: `${f.binDir}:${Deno.env.get("PATH") ?? ""}`,
      FAKE_REMOTE_DIR: f.remoteDir,
      FAKE_SSH_LOG: f.logPath,
      ...extraEnv,
    },
    stdout: "piped",
    stderr: "piped",
  })
  const out = await cmd.output()
  return {
    success: out.success,
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  }
}

// ── In-process IO fake (#233 review) ────────────────────────────────
//
// Every test that needs files to actually land on a "remote" drives
// runDeploy() directly with one of these instead of the real CLI
// subprocess — see the module comment.

function ok(output = ""): CommandResult {
  return { success: true, code: 0, output, error: "" }
}

interface FakeRemote {
  root: string
  calls: string[]
  shellScripts: string[]
  failDeployStack?: string
}

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

function makeFakeIO(remote: FakeRemote): RunDeployIO {
  return {
    checkDockerGroup: async () => {
      remote.calls.push("docker-group")
    },
    needsRemoteSudo: async () => {
      remote.calls.push("sudo")
      return false
    },
    checkRemotePathsNotNested: async () => {
      remote.calls.push("readlink")
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
        return ok()
      }
      const shaMatch = script.match(/^sha256sum '([^']*)'/)
      if (shaMatch) {
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
      return await copyEntry(localDir, destParent, false, extraArgs.includes("--exclude=/stacks"))
    },
    runRemoteSyncEntry: async (
      _address: string,
      localEntryDir: string,
      remoteParentPath: string,
      _extraArgs = [],
    ) => {
      const name = localEntryDir.split("/").filter((p) => p.length > 0).pop()!
      remote.calls.push(`rsync:entry:${name}`)
      const destParent = remote.root + remoteParentPath
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

/**
 * Deploy `server` in-process (no CLI subprocess, no PATH binary at
 * all), against a fresh `FakeRemote` rooted at `f.remoteDir` — the
 * in-process replacement for `runDeployCli` whenever a test needs
 * files to actually reach a "remote".
 */
async function runDeployInProcess(
  f: Fixture,
  opts: { stack?: string; failDeployStack?: string } = {},
): Promise<{ remote: FakeRemote; result: Awaited<ReturnType<typeof runDeploy>> }> {
  const remote: FakeRemote = { root: f.remoteDir, calls: [], shellScripts: [] }
  remote.failDeployStack = opts.failDeployStack
  const result = await runDeploy(
    { cwd: f.projectDir, server: "test", stack: opts.stack },
    makeFakeIO(remote),
  )
  return { remote, result }
}

Deno.test("e2e: deploy ships bundled catalog stacks with no local stacks/ folder", async () => {
  const f = await setupFixture()
  try {
    // No `stacks/` directory in this project at all — every file has to
    // come from the CLI package's bundled catalog. `scripts/` and
    // `deno.jsonc` DO exist here (matching a real project), so "neither
    // reaches the remote" is a real assertion — with nothing to exclude,
    // the old version of this test would have passed even if the
    // whitelist logic were deleted entirely.
    await writeServer(f.projectDir, [], ["librespeed", "jellyfin"])
    await Deno.mkdir(join(f.projectDir, "scripts"), { recursive: true })
    await Deno.writeTextFile(join(f.projectDir, "scripts", "marker.ts"), "// dev-only\n")
    await Deno.writeTextFile(join(f.projectDir, "deno.jsonc"), "{}\n")

    const { remote, result } = await runDeployInProcess(f)
    assertEquals(result.deployedStacks.sort(), ["jellyfin", "librespeed"])

    const remoteApps = join(f.remoteDir, "srv", "apps")

    // The deployed stacks' shipped files reached the remote — proves
    // cli/deploy/shipped-stacks.ts + stack-files.ts resolved them even
    // though `<project>/stacks/` doesn't exist.
    await Deno.stat(join(remoteApps, "stacks", "librespeed", "compose.yml"))
    await Deno.stat(join(remoteApps, "stacks", "jellyfin", "compose.yml"))

    // Only the whitelisted files reached the remote — no ./scripts, no
    // ./deno.jsonc (#203 point 3).
    const rootEntries = new Set(
      [...Deno.readDirSync(remoteApps)].map((e) => e.name),
    )
    assertEquals(rootEntries.has("scripts"), false)
    assertEquals(rootEntries.has("deno.jsonc"), false)
    assertEquals(rootEntries.has(".env"), true)
    assertEquals(rootEntries.has(".env.root"), true)

    // .env.root was created empty in staging (the fixture project has none).
    const rootEnv = await Deno.readTextFile(join(remoteApps, ".env.root"))
    assertEquals(rootEnv, "")

    // The docker-group preflight ran before anything else (#207).
    assert(
      remote.calls.includes("docker-group"),
      `expected a docker-group check, got: ${remote.calls}`,
    )
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: deploy fails a stack that is neither local nor bundled, before syncing anything", async () => {
  const f = await setupFixture()
  try {
    await writeServer(f.projectDir, [], ["not-a-real-stack"])

    const result = await runDeployCli(f, ["deploy", "test"])
    assertEquals(result.success, false)
    assertStringIncludes(result.stderr, "not-a-real-stack")

    // Nothing reached the remote.
    const remoteApps = join(f.remoteDir, "srv", "apps")
    await assertNotExists(remoteApps)
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: deploy rejects a malicious stack name before anything is built", async () => {
  const f = await setupFixture()
  try {
    await writeServer(f.projectDir, [], ["evil\ninjected"])

    const result = await runDeployCli(f, ["deploy", "test"])
    assertEquals(result.success, false)
    assertStringIncludes(result.stderr, "invalid stack name")
    assertStringIncludes(result.stderr, "config.json")

    // Nothing reached the remote — the check runs before staging starts.
    const remoteApps = join(f.remoteDir, "srv", "apps")
    await assertNotExists(remoteApps)
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: SSH_ADDRESS=-oProxyCommand=... is rejected before any ssh/rsync call", async () => {
  // A leading `-` in SSH_ADDRESS would be read as an ssh option — ssh
  // (and rsync, which re-spawns ssh with the same target) would run
  // `-oProxyCommand=<cmd>` as `<cmd>` on THIS machine the moment it
  // parsed the argument, before ever reaching the remote.
  const f = await setupFixture()
  try {
    const pwnedMarker = join(f.projectDir, "PWNED")
    await writeServer(
      f.projectDir,
      [`SSH_ADDRESS=-oProxyCommand=touch ${pwnedMarker}`],
      ["librespeed"],
      { omitKeys: ["SSH_ADDRESS"] },
    )

    const result = await runDeployCli(f, ["deploy", "test"])
    assertEquals(result.success, false)
    assertStringIncludes(result.stderr, "invalid SSH_ADDRESS")

    // No ssh call was made at all — validation ran before the
    // docker-group preflight, the first thing that would call ssh.
    const logExists = await Deno.stat(f.logPath).then(() => true).catch(() => false)
    assertEquals(logExists, false, "no ssh/rsync call should have been made")

    // The injected command never ran.
    const pwned = await Deno.stat(pwnedMarker).then(() => true).catch(() => false)
    assertEquals(pwned, false, "the injected ProxyCommand must never execute")
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: PATH_APPS with $(...) is rejected before any ssh/rsync call", async () => {
  const f = await setupFixture()
  try {
    const pwnedMarker = join(f.projectDir, "PWNED")
    await writeServer(
      f.projectDir,
      [`PATH_APPS=/srv/apps/$(touch ${pwnedMarker})`],
      ["librespeed"],
      { omitKeys: ["PATH_APPS"] },
    )

    const result = await runDeployCli(f, ["deploy", "test"])
    assertEquals(result.success, false)
    assertStringIncludes(result.stderr, "invalid PATH_APPS")

    const logExists = await Deno.stat(f.logPath).then(() => true).catch(() => false)
    assertEquals(logExists, false, "no ssh/rsync call should have been made")

    const pwned = await Deno.stat(pwnedMarker).then(() => true).catch(() => false)
    assertEquals(pwned, false, "the embedded $(...) must never execute")
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: deploy stops on a DOCKER_GROUP_ID mismatch before syncing files (#207)", async () => {
  const f = await setupFixture()
  try {
    await writeServer(f.projectDir, ["DOCKER_GROUP_ID=990"], ["librespeed"])

    const result = await runDeployCli(f, ["deploy", "test"], { FAKE_DOCKER_GID: "988" })
    assertEquals(result.success, false)
    assertStringIncludes(result.stderr, "DOCKER_GROUP_ID mismatch")
    assertStringIncludes(result.stderr, "990")
    assertStringIncludes(result.stderr, "988")

    const remoteApps = join(f.remoteDir, "srv", "apps")
    await assertNotExists(remoteApps)
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: rostok deploy ../escaped refuses before reading anything (#208)", async () => {
  const f = await setupFixture()
  try {
    // No servers/ directory at all — if the CLI read anything before
    // validating the name, this would fail differently (e.g. ENOENT).
    const result = await runDeployCli(f, ["deploy", "../escaped"])
    assertEquals(result.success, false)
    assertStringIncludes(result.stderr, "invalid server name")
    assertCleanFailure(result.stderr)

    const escapedDir = join(f.projectDir, "..", "escaped")
    await assertNotExists(escapedDir)
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: rostok deploy nonexistent fails cleanly through the real entry point — no stack trace (#211, #9)", async () => {
  // A well-formed but nonexistent server name — no servers/nonexistent
  // directory at all. Run through the real cli/+main.ts entry point
  // (runDeployCli spawns it), not an in-process call, so this actually
  // exercises #227's top-level UserError -> "rostok: <message>" wrapper.
  const f = await setupFixture()
  try {
    const result = await runDeployCli(f, ["deploy", "nonexistent"])
    assertEquals(result.success, false)
    assertEquals(result.code, 1)
    assertStringIncludes(result.stderr, "not found")
    assertCleanFailure(result.stderr)
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: server-specific hook overrides run from the staging copy, after the stack's own hook", async () => {
  const f = await setupFixture()
  try {
    // A local (non-catalog) stack — keeps this test independent of any
    // catalog stack's own before.deploy.ts. Its before-hook appends
    // "stack" to SERVER_HOOK_LOG.
    const stackDir = join(f.projectDir, "stacks", "custom-stack")
    await Deno.mkdir(stackDir, { recursive: true })
    await Deno.writeTextFile(
      join(stackDir, "compose.yml"),
      "name: ${PROJECT}\nservices:\n  custom:\n    image: busybox\n",
    )
    await Deno.writeTextFile(
      join(stackDir, "before.deploy.ts"),
      `const logPath = Deno.env.get("SERVER_HOOK_LOG")!
await Deno.writeTextFile(logPath, "stack\\n", { append: true })
`,
    )

    // servers/test/configs/custom-stack/before.deploy.ts — the
    // server-specific override. Like the owner's real hook, it reaches
    // its stack's sibling files with a URL relative to its OWN location
    // (`new URL("../../stacks/custom-stack/", import.meta.url)`), which
    // only resolves to the right place once this hook runs from its
    // staging copy — from its original project location, "../../" would
    // land on `servers/`, not the staging root. It writes a file there;
    // that file must then reach the "remote" through the per-stack
    // sync, the same as any other file under stacks/custom-stack/. It
    // also self-checks that the stack's own hook already ran, and
    // records its own cwd + the contract env keys for the test to
    // assert on.
    const serverHookDir = join(f.projectDir, "servers", "test", "configs", "custom-stack")
    await Deno.mkdir(serverHookDir, { recursive: true })
    await Deno.writeTextFile(
      join(serverHookDir, "before.deploy.ts"),
      `const stackDirUrl = new URL("../../stacks/custom-stack/", import.meta.url)
await Deno.writeTextFile(
  new URL("from-server-hook.txt", stackDirUrl),
  "written by the server-specific hook via import.meta.url\\n",
)

const logPath = Deno.env.get("SERVER_HOOK_LOG")!
const priorContent = await Deno.readTextFile(logPath).catch(() => "")
const env = Deno.env.toObject()
const record = {
  ranAfterStackHook: priorContent.includes("stack"),
  cwd: Deno.cwd(),
  deployAs: env.DEPLOY_AS,
  sshAddress: env.SSH_ADDRESS,
  sshUser: env.SSH_USER,
  pathApps: env.PATH_APPS,
  // #4: the override must receive the REAL stack's own prefixed keys
  // (CUSTOM_STACK_* here — TRAEFIK_* for the real traefik stack) —
  // passing the display label "custom-stack (server override)" into
  // the allowlist instead of the real stack name "custom-stack" would
  // compute a prefix that matches nothing, dropping this key.
  customStackSecret: env.CUSTOM_STACK_SECRET,
}
await Deno.writeTextFile(logPath, "server:" + JSON.stringify(record) + "\\n", { append: true })
`,
    )

    await writeServer(f.projectDir, ["CUSTOM_STACK_SECRET=own-prefixed-value"], ["custom-stack"])

    const hookLog = join(f.remoteDir, "server-hook.json")
    Deno.env.set("SERVER_HOOK_LOG", hookLog)
    let result: Awaited<ReturnType<typeof runDeployInProcess>>["result"]
    try {
      ;({ result } = await runDeployInProcess(f))
    } finally {
      Deno.env.delete("SERVER_HOOK_LOG")
    }
    assertEquals(result.deployedStacks, ["custom-stack"])

    const lines = (await Deno.readTextFile(hookLog)).trim().split("\n")
    assertEquals(lines[0], "stack")
    assertStringIncludes(lines[1], "server:")
    const record = JSON.parse(lines[1].slice("server:".length))
    assertEquals(record.ranAfterStackHook, true)
    // cwd is the staging dir (Deno.makeTempDir({ prefix: "rostok-deploy-" })),
    // never a copy of the hook itself.
    assertStringIncludes(record.cwd, "rostok-deploy-")
    assertEquals(record.deployAs, "custom-stack")
    assertEquals(record.sshAddress, "deploy@remote.test")
    assertEquals(record.sshUser, "deploy")
    assertEquals(record.pathApps, "/srv/apps")
    assertEquals(record.customStackSecret, "own-prefixed-value")

    // The file the server-specific hook wrote via its own import.meta.url
    // reached the remote alongside the rest of the stack's files.
    const shippedFile = join(
      f.remoteDir,
      "srv",
      "apps",
      "stacks",
      "custom-stack",
      "from-server-hook.txt",
    )
    const shippedContent = await Deno.readTextFile(shippedFile)
    assertEquals(shippedContent, "written by the server-specific hook via import.meta.url\n")
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: a hook receives $-heavy env values byte-for-byte (no --env-file mangling)", async () => {
  const f = await setupFixture()
  try {
    // A local stack whose before-hook writes HASH_STACK_SECRET_HASH
    // straight to a file under its own stack dir — that file then
    // reaches the "remote" via the per-stack sync, so the test can
    // check the exact bytes that survived the whole env-passing
    // pipeline (parseEnv → hooks.ts's allowlist → Deno.Command's `env`
    // option → Deno.env.get inside the hook). Deno's own `--env-file`
    // flag mangles `$` in values like bcrypt hashes; rostok never uses
    // it for this reason (see hooks.ts). The key is prefixed with the
    // stack's own name (#217's allowlist, second pass) — an unprefixed
    // SECRET_HASH would now be dropped before it ever reached the hook.
    const stackDir = join(f.projectDir, "stacks", "hash-stack")
    await Deno.mkdir(stackDir, { recursive: true })
    await Deno.writeTextFile(
      join(stackDir, "compose.yml"),
      "name: ${PROJECT}\nservices:\n  hash:\n    image: busybox\n",
    )
    await Deno.writeTextFile(
      join(stackDir, "before.deploy.ts"),
      `const value = Deno.env.get("HASH_STACK_SECRET_HASH") ?? ""
await Deno.writeTextFile("stacks/hash-stack/hash-output.txt", value)
`,
    )

    const bcryptStyleValue = `$2y$05$abc$HOME$def`
    await writeServer(f.projectDir, [`HASH_STACK_SECRET_HASH=${bcryptStyleValue}`], ["hash-stack"])

    const { result } = await runDeployInProcess(f)
    assertEquals(result.deployedStacks, ["hash-stack"])

    const shipped = await Deno.readTextFile(
      join(f.remoteDir, "srv", "apps", "stacks", "hash-stack", "hash-output.txt"),
    )
    assertEquals(shipped, bcryptStyleValue)
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: config.json envs resolves a \${VAR} defined only in .env.root", async () => {
  // Same class of bug as the VOLUMES_PATH regression below: applyStackEnvs
  // used to look up config.json's `${VAR}` references in the raw server
  // .env alone. A var declared only in .env.root would fail with
  // "environment variable '...' not found" instead of resolving.
  const f = await setupFixture()
  try {
    await writeServer(f.projectDir, [], ["librespeed"])
    await writeRootEnv(f.projectDir, ["EXTRA_FROM_ROOT=root-only-value"])

    // config.json's `envs` — writeServer doesn't support this shape, so
    // overwrite the file it wrote with one that adds it.
    await Deno.writeTextFile(
      join(f.projectDir, "servers", "test", "config.json"),
      JSON.stringify({
        stacks: [{ name: "librespeed", envs: { INJECTED_KEY: "${EXTRA_FROM_ROOT}" } }],
      }),
    )

    const { result } = await runDeployInProcess(f)
    assertEquals(result.deployedStacks, ["librespeed"])

    const shippedEnv = await Deno.readTextFile(join(f.remoteDir, "srv", "apps", ".env"))
    assertStringIncludes(shippedEnv, "INJECTED_KEY=root-only-value")
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: VOLUMES_PATH declared only in .env.root still resolves real volume paths", async () => {
  // Regression: run-deploy.ts used to extract volume paths from the
  // server .env alone. With VOLUMES_PATH only in .env.root, the
  // required-key check (which does look at the merge) passed, but the
  // remote ran `mkdir -p '${VOLUMES_PATH}/...'` literally — deploy still
  // reported success.
  const f = await setupFixture()
  try {
    const stackDir = join(f.projectDir, "stacks", "vol-stack")
    await Deno.mkdir(stackDir, { recursive: true })
    await Deno.writeTextFile(
      join(stackDir, "compose.yml"),
      [
        "name: ${PROJECT}",
        "services:",
        "  vol:",
        "    image: busybox",
        "    volumes:",
        "      - ${VOLUMES_PATH}/vol-stack/data:/data:z",
      ].join("\n") + "\n",
    )

    await writeServer(f.projectDir, [], ["vol-stack"], { omitKeys: ["VOLUMES_PATH"] })
    await writeRootEnv(f.projectDir, ["VOLUMES_PATH=/srv/volumes"])

    const { remote, result } = await runDeployInProcess(f)
    assertEquals(result.deployedStacks, ["vol-stack"])

    // The real, merged value reached the remote mkdir/chown command —
    // not the OTHER "mkdir -p" script this deploy also runs
    // (`mkdir -p -- 'PATH_APPS/stacks'`, #233 point 2), hence the
    // volumes-specific match.
    const volumeScript = remote.shellScripts.find((s) => s.includes("mkdir -p '/srv/volumes"))
    assert(
      volumeScript,
      `expected a volume mkdir script, got:\n${remote.shellScripts.join("\n---\n")}`,
    )
    assertStringIncludes(volumeScript!, "mkdir -p '/srv/volumes/vol-stack/data'")
    // ...never the literal, unexpanded placeholder.
    assertEquals(volumeScript!.includes("${VOLUMES_PATH}"), false)
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: a DOCKER_GROUP_ID mismatch names .env.root when that's where the value is", async () => {
  const f = await setupFixture()
  try {
    await writeServer(f.projectDir, [], ["librespeed"], { omitKeys: ["DOCKER_GROUP_ID"] })
    await writeRootEnv(f.projectDir, ["DOCKER_GROUP_ID=990"])

    const result = await runDeployCli(f, ["deploy", "test"], { FAKE_DOCKER_GID: "988" })
    assertEquals(result.success, false)
    assertStringIncludes(result.stderr, "DOCKER_GROUP_ID mismatch")
    assertStringIncludes(result.stderr, ".env.root")
    // Must not tell the operator to edit the server .env when the value
    // actually lives in .env.root.
    assertEquals(result.stderr.includes("servers/test/.env"), false)
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: staged .env and .env.root are chmod 0600", async () => {
  // Both carry secrets, and a real rsync -a would preserve the local
  // staging mode on the remote — a 0644 copy in PATH_APPS is readable
  // by every user on a shared box. The staging dir is private to
  // runDeploy and gets removed before it returns, so this checks the
  // mode from inside, at the point Deno.removeSync is about to delete
  // it — this test never needs the sync to actually run (it fails
  // before reaching that point once VOLUMES_PATH/friends are the only
  // required keys and there are no stacks), so the plain default fake
  // IO below is enough.
  const f = await setupFixture()
  try {
    await writeServer(f.projectDir, [], [])

    const originalRemoveSync = Deno.removeSync
    let envMode: number | null | undefined
    let rootEnvMode: number | null | undefined
    const modeOf = (path: string) => {
      try {
        return Deno.statSync(path).mode
      } catch {
        return undefined
      }
    }
    Deno.removeSync = (path, options) => {
      if (typeof path === "string") {
        envMode = modeOf(join(path, ".env"))
        rootEnvMode = modeOf(join(path, ".env.root"))
      }
      return originalRemoveSync(path, options)
    }

    try {
      await runDeployInProcess(f)
    } finally {
      Deno.removeSync = originalRemoveSync
    }

    assertExists(envMode, "the mock never saw the staging dir's .env")
    assertExists(rootEnvMode, "the mock never saw the staging dir's .env.root")
    assertEquals((envMode! & 0o777).toString(8), "600")
    assertEquals((rootEnvMode! & 0o777).toString(8), "600")
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: a failed staging cleanup logs a warning instead of swallowing it", async () => {
  // runDeploy's own `finally` block removes the staging directory. To
  // observe a failure there, make Deno.remove throw for the duration of
  // this one test.
  const f = await setupFixture()
  try {
    await writeServer(f.projectDir, [], [])

    const originalRemoveSync = Deno.removeSync
    const originalConsoleError = console.error
    const errorLines: string[] = []
    console.error = (...args: unknown[]) => {
      errorLines.push(args.map(String).join(" "))
    }
    // Throws, matching the real Deno.removeSync's failure mode. Records
    // the path it was asked to remove: the mock blocks run-deploy.ts's
    // own cleanup, so this test removes that real staging directory
    // itself afterwards, or it leaks into /tmp on every run.
    let stagingDirToClean: string | URL | undefined
    Deno.removeSync = (path) => {
      stagingDirToClean = path
      throw new Deno.errors.PermissionDenied("simulated: staging cleanup denied")
    }

    try {
      await runDeployInProcess(f)
    } finally {
      Deno.removeSync = originalRemoveSync
      console.error = originalConsoleError
      if (stagingDirToClean !== undefined) {
        await Deno.remove(stagingDirToClean, { recursive: true })
      }
    }

    const warned = errorLines.some((line) =>
      line.includes("Warning: failed to remove staging directory")
    )
    assertEquals(warned, true, `expected a cleanup warning, got: ${errorLines.join(" | ")}`)

    // The mocked Deno.remove blocked run-deploy.ts's own attempt; this
    // test's real cleanup above must have actually removed the
    // directory, or it leaks into /tmp on every run.
    assertExists(stagingDirToClean, "test bug: the mock never recorded a path")
    const stillThere = await Deno.stat(stagingDirToClean).then(() => true).catch((err) => {
      if (err instanceof Deno.errors.NotFound) return false
      throw err
    })
    assertEquals(stillThere, false, `staging dir ${stagingDirToClean} was not cleaned up`)
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: a failed docker compose up throws a UserError naming the stack and the step (#211)", async () => {
  const f = await setupFixture()
  try {
    await writeServer(f.projectDir, [], ["librespeed", "jellyfin"])

    let thrown: unknown
    try {
      await runDeployInProcess(f, { failDeployStack: "librespeed" })
    } catch (err) {
      thrown = err
    }
    assertExists(thrown, "expected runDeploy to throw")
    const message = thrown instanceof Error ? thrown.message : String(thrown)
    // Names the stack...
    assertStringIncludes(message, "librespeed")
    // ...and the step (docker compose up / deploy), not a bare stack trace.
    assertStringIncludes(message, "failed to deploy")
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: an unreachable server fails fast, naming the step and saying it's unreachable (#219, #10)", async () => {
  const f = await setupFixture()
  try {
    await writeServer(f.projectDir, [], ["librespeed"])

    const mainTs = new URL("../+main.ts", import.meta.url).pathname
    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", mainTs, "deploy", "test"],
      cwd: f.projectDir,
      env: {
        ...Deno.env.toObject(),
        PATH: `${f.binDir}:${Deno.env.get("PATH") ?? ""}`,
        FAKE_REMOTE_DIR: f.remoteDir,
        FAKE_SSH_LOG: f.logPath,
        FAKE_SSH_UNREACHABLE: "1",
      },
      stdout: "piped",
      stderr: "piped",
    })
    const child = command.spawn()

    const start = performance.now()
    // Bounded, not a bare `await child.output()`: if a regression drops
    // -o ConnectTimeout=10, FAKE_SSH_UNREACHABLE really hangs (see
    // FAKE_SSH above) — this race turns that into a failed assertion
    // instead of hanging the whole test run, and kills the leftover
    // child so nothing survives this test.
    const timeoutMs = 5_000
    const outcome = await Promise.race([
      child.output().then((o) => ({ timedOut: false as const, o })),
      new Promise<{ timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), timeoutMs)
      ),
    ])
    const elapsedMs = performance.now() - start

    if (outcome.timedOut) {
      try {
        child.kill("SIGKILL")
      } catch {
        // already gone
      }
      await child.output().catch(() => {})
      throw new Error(
        `deploy did not fail within ${timeoutMs}ms — the ConnectTimeout wiring is broken`,
      )
    }

    const stderr = new TextDecoder().decode(outcome.o.stderr)
    assertEquals(outcome.o.success, false)
    assertEquals(outcome.o.code, 1)
    // #10: names the step and says the server is unreachable — not the
    // misleading "docker group not found on <address>", which reads
    // like Docker isn't installed rather than "ssh never connected".
    assertStringIncludes(stderr, "can't reach")
    assertStringIncludes(stderr, "over SSH")
    assertStringIncludes(stderr, "checking the docker group")
    assertEquals(stderr.includes("docker group not found"), false)
    assertCleanFailure(stderr)
    // The fake ssh fails immediately when -o ConnectTimeout=10 is in
    // its argv (see FAKE_SSH_UNREACHABLE in FAKE_SSH above) — this
    // should be near-instant, not the old hardcoded 10s sleep.
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        `deploy took ${elapsedMs.toFixed(0)}ms — expected it to fail almost instantly`,
      )
    }
  } finally {
    await teardownFixture(f)
  }
})

/**
 * True if a process with this pid still exists: signal 0 isn't exposed
 * by Deno, so send SIGCONT, which is harmless to a running process and
 * fails with NotFound once the pid is gone. Needs no external tool (the
 * CI image has no `ps`).
 */
function isPidAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGCONT")
    return true
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false
    throw err
  }
}

/**
 * Poll `isPidAlive` for up to `ms`: a killed process can linger as a
 * zombie for a moment until its new parent reaps it, and a zombie still
 * accepts signals. True if the pid is still there after the wait.
 */
async function isPidAliveAfter(pid: number, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (isPidAlive(pid)) {
    if (Date.now() > deadline) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

/** Poll `path`'s content every 20ms (up to ~10s) until it includes `text`, or throw. */
async function waitForFileToInclude(path: string, text: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const content = await Deno.readTextFile(path).catch(() => "")
    if (content.includes(text)) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`${path} never contained ${JSON.stringify(text)}`)
}

/**
 * The hang point every SIGINT/SIGTERM/SIGHUP test below blocks on:
 * run-deploy.ts's post-staging `mkdir -p -- PATH_APPS/stacks` call
 * (#233 point 2) — the first remote call after staging finishes, and
 * the first one this fixture's FAKE_SSH answers, so it's the natural
 * hang point. Neither a bare "mkdir -p" substring NOR just
 * "-- '/srv/apps/stacks'" is enough (review round, found by actually
 * running this fixture and watching the ssh log): checkRemotePathsNotNested's
 * own preflight (docker-preflight.ts, fixed this round to `mkdir -p`
 * before `readlink -f` on a fresh server) runs BEFORE staging even
 * starts, and its script is `mkdir -p -- '/srv/apps' '/srv/volumes'
 * '/srv/apps/stacks' && readlink -f -- '/srv/apps' && ... && readlink -f
 * -- '/srv/apps/stacks'` — its OWN trailing readlink call also contains
 * "-- '/srv/apps/stacks'" verbatim, so that substring alone still
 * matched the preflight and hung the deploy before staging even began.
 * The full literal "mkdir -p -- '/srv/apps/stacks'" (this exact
 * sequence, immediately adjacent) only ever appears in run-deploy.ts's
 * own post-staging call — the preflight's own "mkdir -p --" is followed
 * by '/srv/apps' first, never directly by the stacks path.
 */
/**
 * Stop a CLI child a signal test spawned but never saw exit (the test
 * threw first), so it can never carry on past the hang point into a
 * later deploy step.
 */
async function killUnfinishedChild(
  child: Deno.ChildProcess | undefined,
  done: boolean,
): Promise<void> {
  if (!child || done) return
  try {
    child.kill("SIGKILL")
  } catch {
    // Already exited.
  }
  await child.output().catch(() => {})
}

const POST_STAGING_MKDIR_HANG_POINT = `mkdir -p -- '/srv/apps/stacks'`

/**
 * Spawn `rostok deploy test` with FAKE_SSH_HANG_ON set (holds the fake
 * ssh call busy — see FAKE_SSH above — after the staging dir is
 * created and populated, but BEFORE any sync would run — #233 review:
 * this file has no `rsync` binary on PATH at all anymore, so the hang
 * point has to be a remote SHELL call, not the old "docker network
 * inspect proxy" (which ran AFTER both syncs). See
 * POST_STAGING_MKDIR_HANG_POINT above for which call and why.) Waits
 * for the fake ssh's own log to actually show the blocking command —
 * not just for the staging dir to exist, which can appear well before
 * that ssh call starts — before sending `signal`. Returns the exit
 * code, whether the staging dir survived, and whether the fake ssh's
 * own pid (written to a file right before it hangs) is still alive
 * afterward — the real proof that deploy KILLED it, not just that
 * deploy itself exited.
 */
async function runInterruptedDeploy(
  f: Fixture,
  signal: Deno.Signal,
): Promise<{ code: number; stagingDirSurvived: boolean; sshStillAlive: boolean }> {
  // A private TMPDIR (per #219's brief: don't race other processes'
  // rostok-deploy-* directories) so this can find, and only find, its
  // own staging dir.
  const tmpRoot = await Deno.makeTempDir({ prefix: "rostok-e2e-tmproot-" })
  const pidFile = join(tmpRoot, "fake-ssh.pid")
  let child: Deno.ChildProcess | undefined
  let childDone = false
  try {
    await writeServer(f.projectDir, [], ["librespeed"])

    const mainTs = new URL("../+main.ts", import.meta.url).pathname
    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", mainTs, "deploy", "test"],
      cwd: f.projectDir,
      env: {
        ...Deno.env.toObject(),
        PATH: `${f.binDir}:${Deno.env.get("PATH") ?? ""}`,
        FAKE_REMOTE_DIR: f.remoteDir,
        FAKE_SSH_LOG: f.logPath,
        // Hold the deploy open after staging is fully populated but
        // before the first sync (see this function's own comment).
        FAKE_SSH_HANG_ON: POST_STAGING_MKDIR_HANG_POINT,
        FAKE_SSH_PID_FILE: pidFile,
        TMPDIR: tmpRoot,
      },
      stdout: "piped",
      stderr: "piped",
    })
    child = command.spawn()

    await waitForFileToInclude(f.logPath, POST_STAGING_MKDIR_HANG_POINT)
    // The blocking ssh call writes its pid before it starts hanging —
    // by the time its own invocation shows up in the log, the pid file
    // exists too, but poll briefly in case of a write-then-flush gap.
    let pid: number | undefined
    for (let i = 0; i < 100 && pid === undefined; i++) {
      const text = await Deno.readTextFile(pidFile).catch(() => "")
      if (text.trim()) pid = Number(text.trim())
      else await new Promise((r) => setTimeout(r, 20))
    }
    if (pid === undefined) throw new Error("fake ssh never wrote its pid file")

    child.kill(signal)
    const output = await child.output()
    childDone = true

    let stagingDirName: string | undefined
    for await (const entry of Deno.readDir(tmpRoot)) {
      if (entry.name.startsWith("rostok-deploy-")) stagingDirName = entry.name
    }
    const stagingDirSurvived = stagingDirName !== undefined &&
      await Deno.stat(join(tmpRoot, stagingDirName)).then(() => true).catch((err) => {
        if (err instanceof Deno.errors.NotFound) return false
        throw err
      })
    const sshStillAlive = await isPidAliveAfter(pid)
    return { code: output.code, stagingDirSurvived, sshStillAlive }
  } finally {
    await killUnfinishedChild(child, childDone)
    await Deno.remove(tmpRoot, { recursive: true }).catch(() => {})
  }
}

Deno.test("e2e: SIGINT during deploy removes the staging directory and kills the fake ssh (#219)", async () => {
  const f = await setupFixture()
  try {
    const { code, stagingDirSurvived, sshStillAlive } = await runInterruptedDeploy(f, "SIGINT")
    assertEquals(code, 130)
    assertEquals(stagingDirSurvived, false)
    assertEquals(sshStillAlive, false, "the fake ssh child survived the signal")
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: SIGTERM during deploy removes the staging directory, kills the fake ssh, exits 143 (#219)", async () => {
  const f = await setupFixture()
  try {
    const { code, stagingDirSurvived, sshStillAlive } = await runInterruptedDeploy(f, "SIGTERM")
    assertEquals(code, 143)
    assertEquals(stagingDirSurvived, false)
    assertEquals(sshStillAlive, false, "the fake ssh child survived the signal")
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: SIGHUP (a closed terminal) during deploy removes the staging directory and kills the fake ssh, exits 129 (#219)", async () => {
  const f = await setupFixture()
  try {
    const { code, stagingDirSurvived, sshStillAlive } = await runInterruptedDeploy(f, "SIGHUP")
    assertEquals(code, 129)
    assertEquals(stagingDirSurvived, false)
    assertEquals(sshStillAlive, false, "the fake ssh child survived the signal")
  } finally {
    await teardownFixture(f)
  }
})

Deno.test("e2e: SIGINT during a ~1,500-file stage leaves no staging directory behind (#219, staging race)", async () => {
  // Regression for a real race: an async signal handler
  // (`killActiveChildren(); await Deno.remove(...)`) let the main
  // flow's own `await fetchToFile(...)` loop keep writing new files
  // into the staging dir WHILE the async removal was concurrently
  // walking and deleting it — observed to survive the signal 3 times
  // out of 5 with a ~1,500-file stack. The fix makes the handler fully
  // synchronous (no `await` anywhere in it), closing the interleaving
  // window entirely. This test means to catch the signal mid-staging,
  // never reaching any remote call at all — but the signal race it's
  // testing is exactly a race: if it loses (signal delivered late,
  // after staging already finished), deploy would carry on into the
  // first sync step, and this fixture has NO `rsync` on PATH at all
  // (#233 review) — a late signal would fall through to the system's
  // REAL rsync. FAKE_SSH_HANG_ON holds it at the first remote shell call
  // instead (same hang point the three dedicated signal tests below
  // use), so a late signal still lands somewhere `sh`-fake and harmless,
  // never at a real sync step.
  const f = await setupFixture()
  const tmpRoot = await Deno.makeTempDir({ prefix: "rostok-e2e-tmproot-" })
  let child: Deno.ChildProcess | undefined
  let childDone = false
  try {
    const stackDir = join(f.projectDir, "stacks", "big-stack")
    await Deno.mkdir(stackDir, { recursive: true })
    await Deno.writeTextFile(
      join(stackDir, "compose.yml"),
      "name: ${PROJECT}\nservices:\n  big:\n    image: busybox\n",
    )
    const fileCount = 1500
    for (let i = 0; i < fileCount; i++) {
      await Deno.writeTextFile(join(stackDir, `file-${String(i).padStart(4, "0")}.txt`), "x")
    }

    await writeServer(f.projectDir, [], ["big-stack"])

    const mainTs = new URL("../+main.ts", import.meta.url).pathname
    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", mainTs, "deploy", "test"],
      cwd: f.projectDir,
      env: {
        ...Deno.env.toObject(),
        PATH: `${f.binDir}:${Deno.env.get("PATH") ?? ""}`,
        FAKE_REMOTE_DIR: f.remoteDir,
        FAKE_SSH_LOG: f.logPath,
        // Never let a late signal fall through staging into a real sync
        // step — see this test's own comment above.
        FAKE_SSH_HANG_ON: POST_STAGING_MKDIR_HANG_POINT,
        TMPDIR: tmpRoot,
      },
      stdout: "piped",
      stderr: "piped",
    })
    child = command.spawn()

    // Send the signal the instant `stacks/` shows up in the staging
    // dir — as early as possible in the file-copy loop, to give the
    // race the widest possible window.
    let stagingDirName: string | undefined
    for (let i = 0; i < 2000 && !stagingDirName; i++) {
      for await (const entry of Deno.readDir(tmpRoot)) {
        if (!entry.name.startsWith("rostok-deploy-")) continue
        const hasStacksDir = await Deno.stat(join(tmpRoot, entry.name, "stacks"))
          .then(() => true)
          .catch(() => false)
        if (hasStacksDir) stagingDirName = entry.name
      }
      if (!stagingDirName) await new Promise((r) => setTimeout(r, 1))
    }
    if (!stagingDirName) throw new Error("stacks/ never appeared under the staging directory")
    const stagingDirPath = join(tmpRoot, stagingDirName)

    child.kill("SIGINT")
    const output = await child.output()
    childDone = true
    assertEquals(output.code, 130)

    await assertNotExists(stagingDirPath)
  } finally {
    await killUnfinishedChild(child, childDone)
    await Deno.remove(tmpRoot, { recursive: true }).catch(() => {})
    await teardownFixture(f)
  }
})

Deno.test("e2e: runDeploy removes its signal listeners after finishing normally (#219)", async () => {
  // Seam: spy on Deno.addSignalListener/removeSignalListener around one
  // successful in-process run-deploy call. A listener registered but
  // never removed would leave this process still reacting to SIGINT
  // after the function returned.
  const f = await setupFixture()
  try {
    await writeServer(f.projectDir, [], [])

    // A private TMPDIR, so the spy below can see this deploy's staging dir.
    const previousTmp = Deno.env.get("TMPDIR")
    const tmpRoot = await Deno.makeTempDir({ prefix: "rostok-e2e-tmproot-" })
    Deno.env.set("TMPDIR", tmpRoot)
    const stagingLeftWhenListenersRemoved: string[][] = []

    const added: Array<[Deno.Signal, unknown]> = []
    const removed: Array<[Deno.Signal, unknown]> = []
    const originalAdd = Deno.addSignalListener
    const originalRemove = Deno.removeSignalListener
    Deno.addSignalListener = (signal: Deno.Signal, handler: () => void) => {
      added.push([signal, handler])
      return originalAdd(signal, handler)
    }
    Deno.removeSignalListener = (signal: Deno.Signal, handler: () => void) => {
      stagingLeftWhenListenersRemoved.push(
        [...Deno.readDirSync(tmpRoot)].map((e) => e.name).filter((n) =>
          n.startsWith("rostok-deploy-")
        ),
      )
      removed.push([signal, handler])
      return originalRemove(signal, handler)
    }

    try {
      await runDeployInProcess(f)
    } finally {
      Deno.addSignalListener = originalAdd
      Deno.removeSignalListener = originalRemove
      if (previousTmp === undefined) Deno.env.delete("TMPDIR")
      else Deno.env.set("TMPDIR", previousTmp)
      await Deno.remove(tmpRoot, { recursive: true }).catch(() => {})
    }

    // #219: staging (plaintext .env) must be gone before the listeners
    // are, or a signal in between takes its default action mid-delete.
    assertEquals(stagingLeftWhenListenersRemoved.length, 4)
    for (const left of stagingLeftWhenListenersRemoved) assertEquals(left, [])

    assertEquals(added.length, 4, "expected exactly SIGHUP, SIGINT, SIGQUIT and SIGTERM")
    assertEquals(
      new Set(added.map(([s]) => s)),
      new Set(["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"]),
    )
    // Every listener that was added was also removed — same signal, same handler.
    assertEquals(removed, added)
  } finally {
    await teardownFixture(f)
  }
})

async function assertNotExists(path: string): Promise<void> {
  let exists = true
  try {
    await Deno.stat(path)
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) exists = false
    else throw err
  }
  assertEquals(exists, false, `expected ${path} not to exist`)
}

/**
 * Assert the shape #211's cli/+main.ts wrapper promises for an expected
 * failure: stderr starts with `rostok: ` and carries no stack-trace
 * line (`    at ...`) — the deploy path threw a UserError, which the
 * wrapper formats cleanly, not an unhandled exception with its default
 * Deno formatting.
 */
function assertCleanFailure(stderr: string): void {
  if (!stderr.startsWith("rostok: ")) {
    throw new Error(`expected stderr to start with "rostok: ", got: ${JSON.stringify(stderr)}`)
  }
  const traceLine = stderr.split("\n").find((line) => line.startsWith("    at "))
  assertEquals(traceLine, undefined, `expected no stack-trace line, got: ${traceLine}`)
  // A plain Error (not UserError) falls into formatCliError's "bug"
  // branch — "rostok: unexpected error: ..." plus a please-report line
  // — which also happens to start with "rostok: " and (with
  // ROSTOK_DEBUG unset) also happens to carry no "    at " line. Reject
  // that branch explicitly so this assertion actually distinguishes a
  // UserError from a bug, not just any thrown value.
  assertEquals(
    stderr.includes("unexpected error"),
    false,
    "deploy threw a plain Error, not UserError",
  )
  assertEquals(stderr.includes("please report"), false, "deploy threw a plain Error, not UserError")
}
