import { assert, assertEquals, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { generateStaleStackCleanupScript } from "./stale-stacks.ts"

/**
 * Run `script` with a fake `docker` on PATH that appends every
 * invocation (argv joined with spaces, plus its own cwd) to a log file,
 * and prints canned `docker ps` output (from a file, never inlined into
 * the fake's own script text — canned output can contain characters,
 * like newlines, that would need their own shell-escaping to survive as
 * a script literal otherwise). Returns the log's lines and the script's
 * own exit code.
 */
/** `sh` or `zsh` — the script must behave identically under both: ssh invokes it through the remote user's own login shell, which is often zsh, not sh. */
type FakeShell = "sh" | "zsh"

async function runWithFakeDocker(
  script: string,
  opts: {
    /** Served for the exact-match scan (a filter with `=<dir>` — `id|project` lines). */
    exactOutput?: string
    /** Served for the broad existence-only scan (phase 2 — bare `working_dir` lines). */
    broadOutput?: string
    failCompose?: boolean
    /**
     * `docker compose -p <project> down` fails only for these project
     * names (others succeed) — lets a test give two stale stacks their
     * own container and fail only one of them, distinct from
     * `failCompose`'s all-or-nothing.
     */
    failComposeProjects?: string[]
    /** `docker ps` itself fails (nonzero exit, no output) for the exact-match filter — simulates the daemon being unreachable while a stack folder still exists. */
    failPsExact?: boolean
    /** `docker ps` itself fails (nonzero exit) for phase 2's broad, unfiltered scan. */
    failPsBroad?: boolean
    /** Runs the script under this shell instead of `sh` — pass "zsh" to prove the same behavior under the remote's likely login shell. */
    shell?: FakeShell
  } = {},
): Promise<{ log: string[]; success: boolean; stdout: string }> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-docker-bin-" })
  const logPath = join(binDir, "log.txt")
  const exactOutputPath = join(binDir, "exact-output.txt")
  const broadOutputPath = join(binDir, "broad-output.txt")
  await Deno.writeTextFile(logPath, "")
  await Deno.writeTextFile(exactOutputPath, opts.exactOutput ?? "")
  await Deno.writeTextFile(broadOutputPath, opts.broadOutput ?? "")
  try {
    // Discriminates the two `docker ps` shapes the script issues: the
    // per-stack exact-match filter always has a "=<dir>" value; the
    // broad, folder-already-gone scan (phase 2) is existence-only.
    const failProjectCase = (opts.failComposeProjects ?? [])
      .map((p) => `    *"-p ${p} "*) exit 1 ;;`)
      .join("\n")
    // Recursion guard (house rule): this fake never calls the real
    // `docker` by name, but every fake gets the same depth-variable
    // guard regardless, so a future edit that DID make it exec
    // something by name can't turn into a fork bomb unnoticed.
    const dockerScript = `#!/bin/sh
if [ -n "$ROSTOK_FAKE_DOCKER_DEPTH" ]; then exit 1; fi
ROSTOK_FAKE_DOCKER_DEPTH=1
export ROSTOK_FAKE_DOCKER_DEPTH
echo "$* (cwd=$(pwd))" >> ${JSON.stringify(logPath)}
if [ "$1" = "ps" ]; then
  case "$*" in
    *"working_dir="*)
      if ${opts.failPsExact ? "true" : "false"}; then
        exit 1
      fi
      cat ${JSON.stringify(exactOutputPath)}
      ;;
    *)
      if ${opts.failPsBroad ? "true" : "false"}; then
        echo "fake docker: ps failed" >&2
        exit 1
      fi
      cat ${JSON.stringify(broadOutputPath)}
      ;;
  esac
elif [ "$1" = "compose" ]; then
  if ${opts.failCompose ? "true" : "false"}; then
    exit 1
  fi
  case "$*" in
${failProjectCase}
  esac
fi
`
    await Deno.writeTextFile(join(binDir, "docker"), dockerScript, { mode: 0o755 })
    const previousPath = Deno.env.get("PATH") ?? ""
    Deno.env.set("PATH", `${binDir}:${previousPath}`)
    try {
      const proc = new Deno.Command(opts.shell ?? "sh", {
        args: ["-c", script],
        stdout: "piped",
        stderr: "piped",
      })
      const out = await proc.output()
      if (!out.success) {
        const stderrText = new TextDecoder().decode(out.stderr)
        const expectedFailure = opts.failCompose || opts.failPsExact || opts.failPsBroad ||
          (opts.failComposeProjects ?? []).length > 0
        if (stderrText.trim() && !expectedFailure) {
          throw new Error(`script errored: ${stderrText}`)
        }
      }
      const log = (await Deno.readTextFile(logPath)).split("\n").filter((l) => l.length > 0)
      return { log, success: out.success, stdout: new TextDecoder().decode(out.stdout) }
    } finally {
      Deno.env.set("PATH", previousPath)
    }
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
}

/** A temp `PATH_APPS` with a `stacks/<name>/compose.yml` for each of `names`. */
async function makeStacksDir(names: string[]): Promise<string> {
  const pathApps = await Deno.makeTempDir({ prefix: "rostok-stale-stacks-test-" })
  for (const name of names) {
    await Deno.mkdir(join(pathApps, "stacks", name), { recursive: true })
    await Deno.writeTextFile(join(pathApps, "stacks", name, "compose.yml"), "services: {}\n")
  }
  return pathApps
}

Deno.test("generateStaleStackCleanupScript: stops a stale stack via its compose PROJECT label, never cd+compose down", async () => {
  const pathApps = await makeStacksDir(["traefik", "oldstack"])
  try {
    const staleDir = join(pathApps, "stacks", "oldstack")
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { log, success } = await runWithFakeDocker(script, {
      exactOutput: `abc123|oldstack-deployed-as\n`,
    })

    assert(success, `script must exit 0 on success, log:\n${log.join("\n")}`)
    assert(
      log.some((l) =>
        l.includes(`ps -a --filter label=com.docker.compose.project.working_dir=${staleDir}`)
      ),
      `expected a working_dir filter scoped to oldstack's own dir, got:\n${log.join("\n")}`,
    )
    assert(
      log.some((l) => l.startsWith("compose -p oldstack-deployed-as down --remove-orphans")),
      `expected docker compose -p <project> down, got:\n${log.join("\n")}`,
    )
    // Never a `cd`-into-folder-then-plain-`docker compose down` call —
    // that form fails for a stack whose compose.yml sets
    // name: ${PROJECT} (see the module comment).
    assert(
      !log.some((l) => /^compose down/.test(l)),
      `must never run a bare "docker compose down", got:\n${log.join("\n")}`,
    )

    const remaining = [...Deno.readDirSync(join(pathApps, "stacks"))].map((e) => e.name).sort()
    assertEquals(remaining, ["traefik"])
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: the 'Removed' message names VOLUMES_PATH as a whole, never a per-stack subfolder (lead review)", async () => {
  // Not every catalog stack lays its data out under VOLUMES_PATH/<name>:
  // usememos keeps its data in .../memos, woodpecker splits into
  // woodpecker-server/woodpecker-agent, and librespeed has no data
  // folder at all. Naming a specific subfolder here would be wrong for
  // part of the catalog, so the message says everything under
  // VOLUMES_PATH survives, not "VOLUMES_PATH/<name>" — the same wording
  // stack-remove.ts's own next-steps message uses.
  const pathApps = await makeStacksDir(["traefik", "oldstack"])
  try {
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { stdout, success, log } = await runWithFakeDocker(script, {
      exactOutput: `abc123|oldstack-deployed-as\n`,
    })
    assert(success, log.join("\n"))
    assertStringIncludes(stdout, "Removed stale stack 'oldstack'. Data under '/srv/volumes' kept.")
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: the 'Stopped' (folder-already-gone) message also names VOLUMES_PATH as a whole", async () => {
  const pathApps = await makeStacksDir(["traefik"])
  try {
    const goneStackDir = join(pathApps, "stacks", "gone-stack")
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { stdout, success, log } = await runWithFakeDocker(script, {
      broadOutput: `${goneStackDir}\n`,
      exactOutput: `abc123|gone-project\n`,
    })
    assert(success, log.join("\n"))
    assertStringIncludes(
      stdout,
      "Stopped stale stack 'gone-stack' (its folder was already gone). Data under " +
        "'/srv/volumes' kept.",
    )
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: removes an orphaned container by label when its folder is already gone", async () => {
  const pathApps = await makeStacksDir(["traefik"])
  try {
    const goneStackDir = join(pathApps, "stacks", "gone-stack")
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { log, success } = await runWithFakeDocker(script, {
      broadOutput: `${goneStackDir}\n`,
      exactOutput: `abc123|gone-project\n`,
    })

    assert(success, `script must exit 0 on success, log:\n${log.join("\n")}`)
    assert(
      log.some((l) => l.startsWith("compose -p gone-project down --remove-orphans")),
      `expected the orphaned container's project to be stopped, got:\n${log.join("\n")}`,
    )
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: never stops a container whose working_dir belongs to an active stack", async () => {
  const pathApps = await makeStacksDir(["traefik"])
  try {
    const traefikDir = join(pathApps, "stacks", "traefik")
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { log, success } = await runWithFakeDocker(script, {
      broadOutput: `${traefikDir}\n`,
    })
    assert(success, log.join("\n"))
    assert(
      !log.some((l) => l.startsWith("compose -p")),
      `an active stack's own container must never be stopped, got:\n${log.join("\n")}`,
    )
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: never stops a container whose working_dir sits outside PATH_APPS/stacks", async () => {
  const pathApps = await makeStacksDir(["traefik"])
  try {
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { log, success } = await runWithFakeDocker(script, {
      broadOutput: `/srv/some-other-project\n`,
    })
    assert(success, log.join("\n"))
    assert(
      !log.some((l) => l.startsWith("compose -p")),
      `a container outside PATH_APPS/stacks must never be stopped, got:\n${log.join("\n")}`,
    )
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: a working_dir under a similarly-prefixed dir (/stacksX) is never matched", async () => {
  // ".../stacks/traefik" as a glob/case PREFIX would also match
  // ".../stacksX/foo" if the boundary weren't exact — STACKS_DIR/* in
  // the script always includes the "/" itself, so "stacksX" (no slash
  // after "stacks") can never match.
  const pathApps = await makeStacksDir(["traefik"])
  try {
    const lookalike = join(pathApps, "stacksX", "foo")
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { log, success } = await runWithFakeDocker(script, {
      broadOutput: `${lookalike}\n`,
    })
    assert(success, log.join("\n"))
    assert(
      !log.some((l) => l.startsWith("compose -p")),
      `a .../stacksX/foo working_dir must never match .../stacks/, got:\n${log.join("\n")}`,
    )
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: an empty active-stack list removes every stack folder (config.json lists none)", async () => {
  const pathApps = await makeStacksDir(["traefik", "gatus"])
  try {
    const script = generateStaleStackCleanupScript([], pathApps, "/srv/volumes")
    const { success } = await runWithFakeDocker(script)
    assert(success)
    const remaining = [...Deno.readDirSync(join(pathApps, "stacks"))]
    assertEquals(remaining, [])
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test('generateStaleStackCleanupScript: an empty stacks/ directory never iterates a literal "*"', async () => {
  // Without the `[ -e "$entry" ] || [ -L "$entry" ]` guard, `for entry in
  // .../stacks/*` on an empty (or missing) directory iterates once with
  // the literal, unexpanded glob text — that would reach the `-d` check
  // with dir_name="*", printing a "skipped '*': not a directory" line
  // instead of staying quiet, and (if the `-d` check were ALSO gone)
  // reach stop_and_remove with name="*", which must never happen (phase
  // 2's own docker ps scan is expected and fine — it's unconditional,
  // and finds nothing here since the fake docker's broad output is
  // empty). This test's own "no 'skipped' text" assertion is what makes
  // the `[ -e ]||[ -L ]` guard provably necessary on its own — without
  // it, the `-d` check alone still stops stop_and_remove from being
  // called, so a weaker test (checking only for that) wouldn't catch
  // this guard's removal (review round).
  const pathApps = await Deno.makeTempDir({ prefix: "rostok-stale-stacks-test-" })
  try {
    await Deno.mkdir(join(pathApps, "stacks"), { recursive: true })
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { log, success, stdout } = await runWithFakeDocker(script)
    assert(success, log.join("\n"))
    assert(
      !log.some((l) => l.includes("working_dir=")),
      `must never reach stop_and_remove for a literal "*", got:\n${log.join("\n")}`,
    )
    assertEquals(stdout.includes("Removed"), false)
    assertEquals(stdout.includes("Stopped"), false)
    assertEquals(
      stdout.includes("skipped"),
      false,
      `an empty stacks/ dir must stay quiet — a literal, unmatched glob is not a real skipped ` +
        `entry, got stdout:\n${stdout}`,
    )
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test('generateStaleStackCleanupScript: an empty stacks/ directory never fails under zsh ("no matches found")', async () => {
  // ssh runs this script through the remote user's LOGIN shell, which
  // is often zsh, not sh. Under zsh's default options, an unmatched
  // glob (this exact case — a fresh server's empty stacks/) doesn't
  // leave the pattern as a literal word the way sh does; it aborts the
  // command with "zsh: no matches found: .../stacks/*" instead, and the
  // `for` loop never even starts. `setopt nullglob`, guarded by
  // `$ZSH_VERSION` so it's a no-op under sh, is what fixes this — this
  // test fails loudly (not silently skips) if `zsh` isn't installed.
  const pathApps = await Deno.makeTempDir({ prefix: "rostok-stale-stacks-test-" })
  try {
    await Deno.mkdir(join(pathApps, "stacks"), { recursive: true })
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { log, success, stdout } = await runWithFakeDocker(script, { shell: "zsh" })
    assert(success, `script failed under zsh, log:\n${log.join("\n")}\nstdout:\n${stdout}`)
    assertEquals(stdout.includes("no matches found"), false, stdout)
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: a MISSING stacks/ directory (fresh server) never errors", async () => {
  const pathApps = await Deno.makeTempDir({ prefix: "rostok-stale-stacks-test-" })
  try {
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { success, log } = await runWithFakeDocker(script)
    assert(success, log.join("\n"))
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: phase 1 — a failed stop keeps the folder, prints no Removed/Stopped (review round)", async () => {
  const pathApps = await makeStacksDir(["traefik", "oldstack"])
  try {
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { success, stdout, log } = await runWithFakeDocker(script, {
      exactOutput: `abc123|oldstack-deployed-as\n`,
      failCompose: true,
    })
    assertEquals(
      success,
      false,
      `script must exit non-zero on a real failure, log:\n${log.join("\n")}`,
    )
    assertStringIncludes(stdout, "FAILED")
    // A failed stop must never print the success messages for that stack.
    assertEquals(stdout.includes("Removed stale stack 'oldstack'"), false)
    assertEquals(stdout.includes("Stopped stale stack 'oldstack'"), false)
    // The operator needs the compose file: the folder must still be there.
    const remaining = [...Deno.readDirSync(join(pathApps, "stacks"))].map((e) => e.name).sort()
    assertEquals(remaining, ["oldstack", "traefik"], "a failed stop must not remove the folder")
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

/**
 * #243 point 3, phase 1: with the FIRST of two stale folders failing to
 * stop, the second must still be tried and removed, and the failure
 * from the first is still visible at the end. Today's phase-1 `for`
 * loop already does this (`stop_and_remove "$dir_name" || FAILED=1`,
 * no `break`) — but nothing exercised TWO stale folders in the same
 * run before, so a regression to `|| { FAILED=1; break; }` would have
 * gone unnoticed.
 */
async function assertPhase1ContinuesPastFailure(shell: FakeShell): Promise<void> {
  const pathApps = await makeStacksDir(["traefik", "oldstack-a", "oldstack-b"])
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-docker-bin-" })
  try {
    const dirA = join(pathApps, "stacks", "oldstack-a")
    const dirB = join(pathApps, "stacks", "oldstack-b")
    const logPath = join(binDir, "log.txt")
    await Deno.writeTextFile(logPath, "")
    const dockerScript = `#!/bin/sh
if [ -n "$ROSTOK_FAKE_DOCKER_DEPTH" ]; then exit 1; fi
ROSTOK_FAKE_DOCKER_DEPTH=1
export ROSTOK_FAKE_DOCKER_DEPTH
echo "$* (cwd=$(pwd))" >> ${JSON.stringify(logPath)}
if [ "$1" = "ps" ]; then
  case "$*" in
    *"working_dir=${dirA}"*) printf 'idA|proj-a\\n' ;;
    *"working_dir=${dirB}"*) printf 'idB|proj-b\\n' ;;
    *"working_dir="*) printf '' ;;
    *) printf '' ;;
  esac
elif [ "$1" = "compose" ]; then
  case "$*" in
    *"-p proj-a "*) exit 1 ;;
  esac
fi
`
    await Deno.writeTextFile(join(binDir, "docker"), dockerScript, { mode: 0o755 })
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const previousPath = Deno.env.get("PATH") ?? ""
    Deno.env.set("PATH", `${binDir}:${previousPath}`)
    try {
      const proc = new Deno.Command(shell, {
        args: ["-c", script],
        stdout: "piped",
        stderr: "piped",
      })
      const out = await proc.output()
      const stdout = new TextDecoder().decode(out.stdout)
      const stderrText = new TextDecoder().decode(out.stderr)
      assertEquals(
        out.success,
        false,
        `oldstack-a's failure must make the script exit non-zero; stdout:\n${stdout}\nstderr:\n${stderrText}`,
      )
      assertStringIncludes(stdout, "FAILED to stop stale stack 'oldstack-a'")
      // The whole point: oldstack-b must still be reached and removed
      // even though it comes AFTER oldstack-a in the same `for` loop.
      assertStringIncludes(stdout, "Removed stale stack 'oldstack-b'")
      const remaining = [...Deno.readDirSync(join(pathApps, "stacks"))].map((e) => e.name).sort()
      assertEquals(
        remaining,
        ["oldstack-a", "traefik"],
        "oldstack-a's folder stays (failed stop); oldstack-b's is gone (succeeded)",
      )
    } finally {
      Deno.env.set("PATH", previousPath)
    }
  } finally {
    await Deno.remove(binDir, { recursive: true })
    await Deno.remove(pathApps, { recursive: true })
  }
}

Deno.test(
  "generateStaleStackCleanupScript: phase 1 — an earlier stale folder's failure never stops a later one from being tried (#243 point 3, sh)",
  () => assertPhase1ContinuesPastFailure("sh"),
)

Deno.test(
  "generateStaleStackCleanupScript: phase 1 — an earlier stale folder's failure never stops a later one from being tried (#243 point 3, zsh)",
  () => assertPhase1ContinuesPastFailure("zsh"),
)

Deno.test("generateStaleStackCleanupScript: phase 1's failed-stop message names the folder; phase 2's own doesn't have one (#243 review)", async () => {
  // "its folder was left in place" is only true for phase 1 (the folder
  // is a real, still-existing directory the operator can go retry). A
  // phase-2 orphan's folder is already gone — that clause would be a
  // lie there, so its own failure message must omit it. One stack in
  // each phase, both failing to stop, so both messages are visible in
  // the same run.
  const pathApps = await makeStacksDir(["traefik", "oldstack"])
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-docker-bin-" })
  try {
    const goneStackDir = join(pathApps, "stacks", "gone-stack")
    const oldstackDir = join(pathApps, "stacks", "oldstack")
    const logPath = join(binDir, "log.txt")
    await Deno.writeTextFile(logPath, "")
    const dockerScript = `#!/bin/sh
echo "$* (cwd=$(pwd))" >> ${JSON.stringify(logPath)}
if [ "$1" = "ps" ]; then
  case "$*" in
    *"working_dir=${oldstackDir}"*) printf 'abc123|oldstack-deployed-as\\n' ;;
    *"working_dir=${goneStackDir}"*) printf 'def456|gone-project\\n' ;;
    *"working_dir="*) printf '' ;;
    *) printf '${goneStackDir}\\n' ;;
  esac
elif [ "$1" = "compose" ]; then
  exit 1
fi
`
    await Deno.writeTextFile(join(binDir, "docker"), dockerScript, { mode: 0o755 })
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const previousPath = Deno.env.get("PATH") ?? ""
    Deno.env.set("PATH", `${binDir}:${previousPath}`)
    try {
      const proc = new Deno.Command("sh", {
        args: ["-c", script],
        stdout: "piped",
        stderr: "piped",
      })
      const out = await proc.output()
      const stdout = new TextDecoder().decode(out.stdout)
      assertEquals(out.success, false, `stdout:\n${stdout}`)
      assertStringIncludes(
        stdout,
        "FAILED to stop stale stack 'oldstack': its folder was left in place.",
      )
      assertStringIncludes(stdout, "FAILED to stop stale stack 'gone-stack'.")
      assertEquals(
        stdout.includes("FAILED to stop stale stack 'gone-stack': its folder was left in place."),
        false,
        `gone-stack's folder is already gone; the message must not claim otherwise, got:\n${stdout}`,
      )
    } finally {
      Deno.env.set("PATH", previousPath)
    }
  } finally {
    await Deno.remove(binDir, { recursive: true })
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: phase 2 — a failed stop survives the piped subshell (review round)", async () => {
  // The container's folder is already gone (this is the "folder-gone"
  // phase 2 scan) — before this fix, `stop_and_remove`'s own `exit 1`
  // only ever escaped the container-stop loop's OWN subshell, and phase
  // 2's call site had no `|| exit 1` of its own, so the failure never
  // reached the script's overall exit status or the printed messages.
  const pathApps = await makeStacksDir(["traefik"])
  try {
    const goneStackDir = join(pathApps, "stacks", "gone-stack")
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { success, stdout, log } = await runWithFakeDocker(script, {
      broadOutput: `${goneStackDir}\n`,
      exactOutput: `abc123|gone-project\n`,
      failCompose: true,
    })
    assertEquals(
      success,
      false,
      `script must exit non-zero when phase 2's stop fails, log:\n${log.join("\n")}`,
    )
    assertStringIncludes(stdout, "FAILED")
    assertEquals(stdout.includes("Stopped stale stack 'gone-stack'"), false)
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

/**
 * #243 point 3: one stale stack failing to stop must never stop the
 * OTHERS from being tried — the deploy still aborts overall, but every
 * stack gets a chance and every failure gets reported. Two entries in
 * the SAME phase-2 loop, the first stop fails, the second succeeds:
 * gone-a's failure must be reported AND gone-b must still be stopped,
 * and the script's own exit status must still reflect gone-a's
 * failure even though gone-b's LATER success runs after it — a while
 * loop's own exit status is just the last command it ran, so without
 * something accumulating the failure across iterations (the `rc`
 * variable in the generated script), gone-b's later success would
 * silently erase gone-a's earlier failure from the final exit code.
 */
async function assertPhase2ContinuesPastFailure(shell: FakeShell): Promise<void> {
  const pathApps = await makeStacksDir(["traefik"])
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-docker-bin-" })
  try {
    const goneA = join(pathApps, "stacks", "gone-a")
    const goneB = join(pathApps, "stacks", "gone-b")
    const logPath = join(binDir, "log.txt")
    await Deno.writeTextFile(logPath, "")
    // The exact-match `ps` query is answered per queried dir (never a
    // single canned blob for every dir) — gone-a has a container whose
    // stop fails, gone-b has one whose stop succeeds.
    const dockerScript = `#!/bin/sh
if [ -n "$ROSTOK_FAKE_DOCKER_DEPTH" ]; then exit 1; fi
ROSTOK_FAKE_DOCKER_DEPTH=1
export ROSTOK_FAKE_DOCKER_DEPTH
echo "$* (cwd=$(pwd))" >> ${JSON.stringify(logPath)}
if [ "$1" = "ps" ]; then
  case "$*" in
    *"working_dir=${goneA}"*) printf 'idA|proj-a\\n' ;;
    *"working_dir=${goneB}"*) printf 'idB|proj-b\\n' ;;
    *"working_dir="*) printf '' ;;
    *) printf '${goneA}\\n${goneB}\\n' ;;
  esac
elif [ "$1" = "compose" ]; then
  case "$*" in
    *"-p proj-a "*) exit 1 ;;
  esac
fi
`
    await Deno.writeTextFile(join(binDir, "docker"), dockerScript, { mode: 0o755 })
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const previousPath = Deno.env.get("PATH") ?? ""
    Deno.env.set("PATH", `${binDir}:${previousPath}`)
    try {
      const proc = new Deno.Command(shell, {
        args: ["-c", script],
        stdout: "piped",
        stderr: "piped",
      })
      const out = await proc.output()
      const stdout = new TextDecoder().decode(out.stdout)
      const stderrText = new TextDecoder().decode(out.stderr)
      assertEquals(
        out.success,
        false,
        `gone-a's failure must still make the script exit non-zero, even though gone-b ` +
          `succeeds afterwards; stdout:\n${stdout}\nstderr:\n${stderrText}`,
      )
      assertStringIncludes(stdout, "FAILED to stop stale stack 'gone-a'")
      assertEquals(stdout.includes("Stopped stale stack 'gone-a'"), false)
      // #243 point 3: gone-a's failure must NOT stop gone-b from being
      // tried. This is the flip of this test's pre-#243 assertion,
      // which required the opposite (fail-fast) behaviour.
      assertStringIncludes(stdout, "Stopped stale stack 'gone-b'")
    } finally {
      Deno.env.set("PATH", previousPath)
    }
  } finally {
    await Deno.remove(binDir, { recursive: true })
    await Deno.remove(pathApps, { recursive: true })
  }
}

Deno.test(
  "generateStaleStackCleanupScript: phase 2 — an earlier entry's failure never stops a later entry from being tried (#243 point 3, sh)",
  () => assertPhase2ContinuesPastFailure("sh"),
)

Deno.test(
  "generateStaleStackCleanupScript: phase 2 — an earlier entry's failure never stops a later entry from being tried (#243 point 3, zsh)",
  () => assertPhase2ContinuesPastFailure("zsh"),
)

Deno.test("generateStaleStackCleanupScript: phase-2 label '..' is rejected by the name guard, not the */* segment check (review round)", async () => {
  // "..": no "/" in it, so the phase-2 `case "$rel" in */*) continue`
  // segment check does NOT catch it — only the name-shape guard inside
  // stop_and_remove does. Proves the two guards aren't hiding behind
  // each other for this shape.
  const pathApps = await makeStacksDir(["traefik"])
  try {
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { success, stdout, log } = await runWithFakeDocker(script, {
      broadOutput: `${pathApps}/stacks/..\n`,
    })
    assert(success, log.join("\n"))
    assert(
      !log.some((l) => l.startsWith("compose -p") || l.startsWith("rm ")),
      `an unsafe-shaped name must never reach docker compose or rm, got:\n${log.join("\n")}`,
    )
    assertStringIncludes(stdout, "unsafe name")
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: phase-2 label with a space ('a b') is rejected by the name guard (review round)", async () => {
  const pathApps = await makeStacksDir(["traefik"])
  try {
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { success, stdout, log } = await runWithFakeDocker(script, {
      broadOutput: `${join(pathApps, "stacks", "a b")}\n`,
    })
    assert(success, log.join("\n"))
    assert(
      !log.some((l) => l.startsWith("compose -p") || l.startsWith("rm ")),
      `an unsafe-shaped name must never reach docker compose or rm, got:\n${log.join("\n")}`,
    )
    assertStringIncludes(stdout, "unsafe name")
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: an unsafe name is printed with escape bytes and newlines replaced", async () => {
  // A label or folder name planted on the server must not reach the
  // operator's terminal as an escape sequence or a fake extra line.
  const pathApps = await makeStacksDir(["traefik"])
  try {
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const planted = "x\x1b]0;PWNED\x07\nRemoved stale stack 'traefik'"
    const { success, stdout, log } = await runWithFakeDocker(script, {
      broadOutput: `${join(pathApps, "stacks", "x\x1b]0;PWNED\x07")}\n`,
    })
    assert(success, log.join("\n"))
    assertStringIncludes(stdout, "skipped 'x??0?PWNED?': unsafe name")
    assertEquals(stdout.includes("\x1b"), false, stdout)
    assertEquals(stdout.includes("\x07"), false, stdout)

    // A folder whose name holds a newline prints as one line.
    await Deno.mkdir(join(pathApps, "stacks", planted))
    const second = await runWithFakeDocker(script)
    assertStringIncludes(second.stdout, "skipped 'x??0?PWNED??Removed stale stack ?traefik?'")
    assertEquals(second.stdout.includes("\nRemoved stale stack 'traefik'"), false, second.stdout)
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: a file symlink under stacks/ is skipped and reported, not silently ignored (review round)", async () => {
  const pathApps = await Deno.makeTempDir({ prefix: "rostok-stale-stacks-test-" })
  try {
    await Deno.mkdir(join(pathApps, "stacks"), { recursive: true })
    const targetFile = join(pathApps, "afile.txt")
    await Deno.writeTextFile(targetFile, "just a file")
    await Deno.symlink(targetFile, join(pathApps, "stacks", "not-a-stack"))

    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { success, stdout, log } = await runWithFakeDocker(script)
    assert(success, log.join("\n"))
    assert(
      !log.some((l) => l.startsWith("compose -p") || l.startsWith("rm ")),
      `a file symlink must never reach docker compose or rm, got:\n${log.join("\n")}`,
    )
    assertStringIncludes(stdout, "not-a-stack")
    assertStringIncludes(stdout, "not a directory")
    // The symlink (and its target) must survive untouched.
    assertEquals(await Deno.readTextFile(targetFile), "just a file")
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: a BROKEN symlink with a still-running container is stopped and removed (#243 review — regression fix)", async () => {
  // Phase 1 never calls stop_and_remove for a broken symlink (or any
  // non-directory entry) under stacks/ — it reports "not a directory"
  // and moves on (the test above). Phase 2's broad scan is therefore
  // the ONLY place that can ever stop a container still running behind
  // one, and origin/main does exactly that. The branch's own guard
  // must skip a phase-2 entry only when `[ -d ... ]` is true (a REAL
  // directory phase 1 already handled) — skipping on `-e`/`-L`
  // instead (this branch's earlier mistake) would also match a broken
  // symlink and silently stop this from ever happening again.
  const pathApps = await Deno.makeTempDir({ prefix: "rostok-stale-stacks-test-" })
  try {
    await Deno.mkdir(join(pathApps, "stacks"), { recursive: true })
    const brokenLink = join(pathApps, "stacks", "orphan-symlink")
    await Deno.symlink(join(pathApps, "does-not-exist"), brokenLink)

    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { success, stdout, log } = await runWithFakeDocker(script, {
      broadOutput: `${brokenLink}\n`,
      exactOutput: `abc123|orphan-project\n`,
    })
    assert(success, log.join("\n"))
    assert(
      log.some((l) => l.startsWith("compose -p orphan-project down --remove-orphans")),
      `expected the orphaned container behind the broken symlink to be stopped, got:\n${
        log.join("\n")
      }`,
    )
    let symlinkGone = false
    try {
      await Deno.lstat(brokenLink)
    } catch {
      symlinkGone = true
    }
    assert(symlinkGone, "the broken symlink itself must be removed once its container is stopped")
    assertStringIncludes(stdout, "Removed stale stack 'orphan-symlink'")
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test('generateStaleStackCleanupScript: phase 2\'s own docker ps failing is reported and fails the script, never read as "nothing to stop" (#243 review)', async () => {
  const pathApps = await makeStacksDir(["traefik"])
  try {
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { success, stdout, log } = await runWithFakeDocker(script, { failPsBroad: true })
    assertEquals(
      success,
      false,
      `script must exit non-zero when phase 2's own docker ps fails, log:\n${log.join("\n")}`,
    )
    assertStringIncludes(stdout, "FAILED to list containers for the orphaned-container scan.")
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test('generateStaleStackCleanupScript: stop_and_remove\'s own docker ps failing omits "left in place" once its folder is already gone (#243 review)', async () => {
  // Reached via phase 2 (the folder never existed — this is the
  // "already gone" shape), so the message must not claim a folder was
  // left in place; that clause is only true for phase 1's callers.
  const pathApps = await makeStacksDir(["traefik"])
  try {
    const goneStackDir = join(pathApps, "stacks", "gone-stack")
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { success, stdout, log } = await runWithFakeDocker(script, {
      broadOutput: `${goneStackDir}\n`,
      failPsExact: true,
    })
    assertEquals(success, false, log.join("\n"))
    assertStringIncludes(stdout, "FAILED to list containers for stale stack 'gone-stack'.")
    assertEquals(
      stdout.includes("FAILED to list containers for stale stack 'gone-stack': its folder"),
      false,
      stdout,
    )
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: removing the name-shape guard lets 'a b' through (mutation proof)", async () => {
  // Same script shape as the "a b" name-guard test above, but with the
  // guard's case arm rewritten to a no-op match so nothing is rejected
  // — proves that test actually exercises the guard, not some other
  // check that happens to reject the same input. "a b"'s dir is never
  // created on disk, so with the guard gone execution reaches the
  // "already gone" branch (no real `rm` involved) rather than
  // `stacks/..`, whose own dir DOES exist and would hit the host
  // `rm`'s unrelated "refusing to remove '..'" safety net instead of
  // proving anything about this guard.
  const pathApps = await makeStacksDir(["traefik"])
  try {
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const mutated = script.replace(
      "    ''|*[!A-Za-z0-9_-]*)\n      echo \"skipped '$(printable \"$name\")': unsafe name\"\n      return 0\n      ;;\n",
      "    __never_matches__) return 0 ;;\n",
    )
    assert(mutated !== script, "mutation string not found in generated script")
    const { stdout, log, success } = await runWithFakeDocker(mutated, {
      broadOutput: `${pathApps}/stacks/a b\n`,
    })
    assert(success, log.join("\n"))
    assertStringIncludes(
      stdout,
      "Stopped stale stack 'a b'",
      `expected the mutated script to process 'a b' once the guard is gone, got:\n${stdout}`,
    )
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: unlinks a symlinked stack folder, never follows it into its target", async () => {
  const pathApps = await Deno.makeTempDir({ prefix: "rostok-stale-stacks-test-" })
  try {
    await Deno.mkdir(join(pathApps, "stacks", "traefik"), { recursive: true })
    const volumesTarget = await Deno.makeTempDir({ prefix: "rostok-stale-volumes-test-" })
    try {
      await Deno.writeTextFile(join(volumesTarget, "important-data.txt"), "keep me")
      await Deno.symlink(volumesTarget, join(pathApps, "stacks", "oldstack"), { type: "dir" })

      const script = generateStaleStackCleanupScript(["traefik"], pathApps, volumesTarget)
      const { success, log } = await runWithFakeDocker(script)
      assert(success, log.join("\n"))

      const remaining = [...Deno.readDirSync(join(pathApps, "stacks"))].map((e) => e.name).sort()
      assertEquals(remaining, ["traefik"])
      assertEquals(await Deno.readTextFile(join(volumesTarget, "important-data.txt")), "keep me")
    } finally {
      await Deno.remove(volumesTarget, { recursive: true })
    }
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: single-quotes every stack name in the case patterns (shQuote)", () => {
  const script = generateStaleStackCleanupScript(
    ["a-stack", "$(touch pwned)"],
    "/srv/apps",
    "/srv/volumes",
  )
  // shQuote wraps `" ${name} "` (spaces included, so "traefik" can't
  // also match a folder named "traefik-old") in single quotes — a raw,
  // unquoted "$(touch pwned)" in a case pattern would let the shell
  // expand and run it while just parsing the pattern.
  assertStringIncludes(script, "' $(touch pwned) '")
})

Deno.test("generateStaleStackCleanupScript: never emits an rm/docker command rooted at VOLUMES_PATH", () => {
  const script = generateStaleStackCleanupScript(["traefik"], "/srv/apps", "/srv/volumes")
  for (const line of script.split("\n")) {
    if (/\brm\s|\bdocker\s/.test(line)) {
      assertEquals(
        line.includes("/srv/volumes"),
        false,
        `a command line referenced VOLUMES_PATH: ${line}`,
      )
    }
  }
})

Deno.test("generateStaleStackCleanupScript: `docker ps` itself failing keeps the folder, never prints Removed (#243 review)", async () => {
  // Before this fix, `docker ps ... | while read ...; do ...; done`
  // lost `docker ps`'s own exit code: an empty-input `while` loop exits
  // 0 regardless of why its input was empty, so a failing `docker ps`
  // (daemon unreachable) read as "found zero containers" and cleanup
  // went on to `rm -rf` the folder without ever having actually checked
  // for running containers.
  const pathApps = await makeStacksDir(["traefik", "oldstack"])
  try {
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { success, stdout, log } = await runWithFakeDocker(script, { failPsExact: true })
    assertEquals(
      success,
      false,
      `script must exit non-zero when docker ps itself fails, log:\n${log.join("\n")}`,
    )
    assertStringIncludes(stdout, "FAILED")
    assertEquals(stdout.includes("Removed stale stack 'oldstack'"), false)
    assertEquals(stdout.includes("Stopped stale stack 'oldstack'"), false)
    const remaining = [...Deno.readDirSync(join(pathApps, "stacks"))].map((e) => e.name).sort()
    assertEquals(
      remaining,
      ["oldstack", "traefik"],
      "a docker ps failure must not remove the folder",
    )
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: a failed-to-stop stack's folder gets one FAILED report, not two (#243 review)", async () => {
  // Phase 1 (exact per-folder scan) tries "oldstack", fails to stop it,
  // and — correctly — leaves its folder in place. Phase 2's broad scan
  // (any container under STACKS_DIR, folder-existence-agnostic) then
  // sees the SAME still-running container again. Before the guard that
  // skips a name whose folder still exists, phase 2 would call
  // stop_and_remove("oldstack") a second time and print a second FAILED
  // line for the one stack phase 1 already reported.
  const pathApps = await makeStacksDir(["traefik", "oldstack"])
  try {
    const oldstackDir = join(pathApps, "stacks", "oldstack")
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { success, stdout, log } = await runWithFakeDocker(script, {
      exactOutput: `abc123|oldstack-deployed-as\n`,
      broadOutput: `${oldstackDir}\n`,
      failCompose: true,
    })
    assertEquals(success, false, `script must fail, log:\n${log.join("\n")}`)
    const failedCount = stdout.split("\n")
      .filter((l) => l.includes("FAILED to stop stale stack 'oldstack'")).length
    assertEquals(
      failedCount,
      1,
      `expected exactly one 'FAILED to stop stale stack' line for 'oldstack', got ` +
        `${failedCount}:\n${stdout}`,
    )
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: removing the phase-2 already-handled guard reports a stopped stack twice (mutation proof)", async () => {
  // Same scenario as the double-report test above, but with the guard's
  // case arm rewritten to a no-op so phase 2 reaches stop_and_remove
  // again unconditionally — proves the guard, not some other check, is
  // what stops the duplicate report.
  const pathApps = await makeStacksDir(["traefik", "oldstack"])
  try {
    const oldstackDir = join(pathApps, "stacks", "oldstack")
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const mutated = script.replace(
      '    case "$rel" in\n' +
        "      ''|*[!A-Za-z0-9_-]*) ;;\n" +
        "      *)\n" +
        '        if [ -d "$STACKS_DIR/$rel" ]; then continue; fi\n' +
        "        ;;\n" +
        "    esac\n",
      "",
    )
    assert(mutated !== script, "mutation string not found in generated script")
    const { success, stdout, log } = await runWithFakeDocker(mutated, {
      exactOutput: `abc123|oldstack-deployed-as\n`,
      broadOutput: `${oldstackDir}\n`,
      failCompose: true,
    })
    assertEquals(success, false, log.join("\n"))
    const failedCount = stdout.split("\n")
      .filter((l) => l.includes("FAILED to stop stale stack 'oldstack'")).length
    assertEquals(
      failedCount,
      2,
      `expected the mutated script to report 'oldstack' twice, got ${failedCount}:\n${stdout}`,
    )
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: a 'not a directory' entry's name is printed with escape bytes replaced (#243 review)", async () => {
  // The stale-cleanup review already strips control characters from an
  // UNSAFE-NAME skip (tested above) — this proves the separate
  // "not a directory" skip (a file, not a symlink, sitting directly
  // under stacks/) gets the same treatment, since it's a distinct
  // `echo` line in the generated script.
  const pathApps = await Deno.makeTempDir({ prefix: "rostok-stale-stacks-test-" })
  try {
    await Deno.mkdir(join(pathApps, "stacks"), { recursive: true })
    const plantedName = "x\x1b]0;PWNED\x07"
    await Deno.writeTextFile(join(pathApps, "stacks", plantedName), "just a file")

    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const { success, stdout, log } = await runWithFakeDocker(script)
    assert(success, log.join("\n"))
    assertStringIncludes(stdout, "skipped 'x??0?PWNED?': not a directory")
    assertEquals(stdout.includes("\x1b"), false, stdout)
    assertEquals(stdout.includes("\x07"), false, stdout)
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})
