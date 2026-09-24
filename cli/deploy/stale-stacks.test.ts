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
async function runWithFakeDocker(
  script: string,
  opts: {
    /** Served for the exact-match scan (a filter with `=<dir>` — `id|project` lines). */
    exactOutput?: string
    /** Served for the broad existence-only scan (phase 2 — bare `working_dir` lines). */
    broadOutput?: string
    failCompose?: boolean
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
    const dockerScript = `#!/bin/sh
echo "$* (cwd=$(pwd))" >> ${JSON.stringify(logPath)}
if [ "$1" = "ps" ]; then
  case "$*" in
    *"working_dir="*) cat ${JSON.stringify(exactOutputPath)} ;;
    *) cat ${JSON.stringify(broadOutputPath)} ;;
  esac
elif [ "$1" = "compose" ] && ${opts.failCompose ? "true" : "false"}; then
  exit 1
fi
`
    await Deno.writeTextFile(join(binDir, "docker"), dockerScript, { mode: 0o755 })
    const previousPath = Deno.env.get("PATH") ?? ""
    Deno.env.set("PATH", `${binDir}:${previousPath}`)
    try {
      const proc = new Deno.Command("sh", {
        args: ["-c", script],
        stdout: "piped",
        stderr: "piped",
      })
      const out = await proc.output()
      if (!out.success) {
        const stderrText = new TextDecoder().decode(out.stderr)
        if (stderrText.trim() && !opts.failCompose) {
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
  // Without the `[ -e "$entry" ]` guard, `for entry in .../stacks/*/`
  // on an empty (or missing) directory iterates once with the literal,
  // unexpanded glob text — that would reach stop_and_remove with
  // name="*", which must never happen (phase 2's own docker ps scan is
  // expected and fine — it's unconditional, and finds nothing here
  // since the fake docker's broad output is empty).
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

Deno.test("generateStaleStackCleanupScript: reports failure (non-zero exit) when a docker compose down fails", async () => {
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
    // A failed stop must never print "Removed" for that stack.
    assertEquals(stdout.includes("Removed 'oldstack'"), false)
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
