import { assert, assertEquals, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { generateStaleStackCleanupScript } from "./stale-stacks.ts"

/**
 * Run `script` with a fake `docker` on PATH that appends every
 * invocation (argv joined with spaces, plus its own cwd) to a log file,
 * and prints canned `docker ps` output. Returns the log's lines.
 */
async function runWithFakeDocker(
  script: string,
  opts: { psOutput?: string } = {},
): Promise<string[]> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-docker-bin-" })
  const logPath = join(binDir, "log.txt")
  const psOutputPath = join(binDir, "ps-output.txt")
  await Deno.writeTextFile(logPath, "")
  // Written to its own file, not inlined into the fake docker script's
  // own text — psOutput can contain newlines/`$`/backticks that would
  // otherwise need their own shell-escaping to survive as a script
  // literal.
  await Deno.writeTextFile(psOutputPath, opts.psOutput ?? "")
  try {
    const dockerScript = `#!/bin/sh
echo "$* (cwd=$(pwd))" >> ${JSON.stringify(logPath)}
if [ "$1" = "ps" ]; then
  cat ${JSON.stringify(psOutputPath)}
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
        throw new Error(
          `script failed: ${new TextDecoder().decode(out.stderr)}`,
        )
      }
    } finally {
      Deno.env.set("PATH", previousPath)
    }
    const log = await Deno.readTextFile(logPath)
    return log.split("\n").filter((l) => l.length > 0)
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

Deno.test("generateStaleStackCleanupScript: stops and removes a stale stack, keeps its volumes untouched", async () => {
  const pathApps = await Deno.makeTempDir({ prefix: "rostok-stale-stacks-test-" })
  try {
    const volumesPath = await Deno.makeTempDir({ prefix: "rostok-stale-volumes-test-" })
    try {
      await Deno.mkdir(join(pathApps, "stacks", "traefik"), { recursive: true })
      await Deno.mkdir(join(pathApps, "stacks", "oldstack"), { recursive: true })
      await Deno.writeTextFile(join(volumesPath, "oldstack-marker"), "keep-me")

      const script = generateStaleStackCleanupScript(["traefik"], pathApps, volumesPath)
      const log = await runWithFakeDocker(script)

      assert(
        log.some((l) =>
          l.startsWith("compose down --remove-orphans") &&
          l.includes(`cwd=${join(pathApps, "stacks", "oldstack")}`)
        ),
        `expected a compose down in oldstack's own folder, got:\n${log.join("\n")}`,
      )
      // Never ran for the active stack.
      assert(
        !log.some((l) => l.includes(`cwd=${join(pathApps, "stacks", "traefik")}`)),
        `traefik's own folder must never see docker compose down, got:\n${log.join("\n")}`,
      )

      const remaining = [...Deno.readDirSync(join(pathApps, "stacks"))].map((e) => e.name).sort()
      assertEquals(remaining, ["traefik"])

      // VOLUMES_PATH is never referenced by an rm/mkdir command — only
      // named in the printed message — so the marker file must survive.
      assertEquals(await Deno.readTextFile(join(volumesPath, "oldstack-marker")), "keep-me")
    } finally {
      await Deno.remove(volumesPath, { recursive: true })
    }
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: removes an orphaned container by label when its folder is already gone", async () => {
  const pathApps = await makeStacksDir(["traefik"])
  try {
    const goneStackWorkingDir = join(pathApps, "stacks", "gone-stack")
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const log = await runWithFakeDocker(script, {
      psOutput: `abc123|${goneStackWorkingDir}\n`,
    })

    assert(
      log.some((l) => l.startsWith("rm -f abc123")),
      `expected the orphaned container to be removed, got:\n${log.join("\n")}`,
    )
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: never removes a container whose working_dir belongs to an active stack", async () => {
  const pathApps = await makeStacksDir(["traefik"])
  try {
    const traefikWorkingDir = join(pathApps, "stacks", "traefik")
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const log = await runWithFakeDocker(script, {
      psOutput: `abc123|${traefikWorkingDir}\n`,
    })

    assert(
      !log.some((l) => l.startsWith("rm -f")),
      `an active stack's own container must never be removed, got:\n${log.join("\n")}`,
    )
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: never removes a container whose working_dir sits outside PATH_APPS/stacks", async () => {
  const pathApps = await makeStacksDir(["traefik"])
  try {
    // A container from some other, unrelated compose project on the same
    // host — its working_dir isn't under this PATH_APPS/stacks at all,
    // so it must never be touched, active-stack list or not.
    const script = generateStaleStackCleanupScript(["traefik"], pathApps, "/srv/volumes")
    const log = await runWithFakeDocker(script, {
      psOutput: `abc123|/srv/some-other-project\n`,
    })

    assert(
      !log.some((l) => l.startsWith("rm -f")),
      `a container outside PATH_APPS/stacks must never be removed, got:\n${log.join("\n")}`,
    )
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("generateStaleStackCleanupScript: an empty active-stack list removes every stack folder (config.json lists none)", async () => {
  const pathApps = await makeStacksDir(["traefik", "gatus"])
  try {
    const script = generateStaleStackCleanupScript([], pathApps, "/srv/volumes")
    await runWithFakeDocker(script)
    const remaining = [...Deno.readDirSync(join(pathApps, "stacks"))]
    assertEquals(remaining, [])
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
  // shQuote wraps `" ${name} "` (spaces included, so "traefik" can't also
  // match a folder named "traefik-old") in single quotes — a raw,
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
