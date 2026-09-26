import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import { join } from "@std/path"
import { extractVolumePaths, generateVolumeCreationScript } from "./volumes.ts"
import { UserError } from "../errors.ts"

Deno.test("extractVolumePaths finds VOLUMES_PATH references", () => {
  const composeContents = [
    `
services:
  app:
    volumes:
      - \${VOLUMES_PATH}/myapp/data:/data:z
`,
  ]
  const env = { VOLUMES_PATH: "/volumes" }
  const paths = extractVolumePaths(composeContents, env)
  assertEquals(paths, ["/volumes/myapp/data"])
})

Deno.test("extractVolumePaths handles multiple compose files", () => {
  const composeContents = [
    `- \${VOLUMES_PATH}/app1/data:/data:z`,
    `- \${VOLUMES_PATH}/app2/logs:/logs:z`,
  ]
  const paths = extractVolumePaths(composeContents, { VOLUMES_PATH: "/vol" })
  assertEquals(paths.includes("/vol/app1/data"), true)
  assertEquals(paths.includes("/vol/app2/logs"), true)
})

Deno.test("generateVolumeCreationScript chowns to PUID:PGID, not a user name", () => {
  const script = generateVolumeCreationScript(["/volumes/app/data"], "1000", "1000", false)
  assertStringIncludes(script, "mkdir -p '/volumes/app/data'")
  assertStringIncludes(script, "chown -R '1000':'1000' '/volumes/app/data'")
})

Deno.test("generateVolumeCreationScript never hides a failure", () => {
  const script = generateVolumeCreationScript(["/volumes/app/data"], "1000", "1000", false)
  assertEquals(script.includes("|| true"), false)
  assertEquals(script.includes("2>/dev/null"), false)
})

Deno.test("generateVolumeCreationScript: no sudo prefix when the remote is already root", () => {
  const script = generateVolumeCreationScript(["/volumes/app"], "1000", "1000", false)
  assertEquals(script.includes("sudo"), false)
})

Deno.test("generateVolumeCreationScript: prefixes mkdir and chown with sudo -n when the remote needs it", () => {
  const script = generateVolumeCreationScript(["/volumes/app"], "1000", "1000", true)
  assertStringIncludes(script, "sudo -n mkdir -p -- '/volumes/app'")
  assertStringIncludes(script, "sudo -n chown -R '1000':'1000' -- '/volumes/app'")
})

Deno.test("generateVolumeCreationScript: the ownership check compares uid first, then gid", () => {
  const script = generateVolumeCreationScript(["/volumes/app"], "1000", "1001", true)
  assertStringIncludes(script, `[ "$(stat -c %u:%g -- '/volumes/app')" = '1000':'1001' ]`)
})

Deno.test("generateVolumeCreationScript joins multiple paths with &&", () => {
  const script = generateVolumeCreationScript(
    ["/volumes/a", "/volumes/b"],
    "1000",
    "1000",
    false,
  )
  assertEquals(
    script,
    "mkdir -p '/volumes/a' && chown -R '1000':'1000' '/volumes/a' && " +
      "mkdir -p '/volumes/b' && chown -R '1000':'1000' '/volumes/b'",
  )
})

Deno.test("generateVolumeCreationScript: a path with $(), \" and ' never executes as a command", async () => {
  // Real end-to-end proof, not a string match: build a path that contains
  // shell metacharacters, run the generated script for real through
  // `sh -c`, and confirm mkdir/chown received the LITERAL path (no
  // substitution ran) — the old double-quoted version
  // (`mkdir -p "$path"`) would have let `$(...)` execute here.
  const tmp = await Deno.makeTempDir({ prefix: "rostok-volumes-inject-" })
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-chown-" })
  const chownLog = join(binDir, "chown.log")
  try {
    // A directory name that is itself valid on a real filesystem but
    // would break out of double quotes and run a command substitution.
    const weirdName = `weird$(touch ${tmp}/INJECTED)"quote'quote`
    const weirdPath = join(tmp, weirdName)

    // Fake `chown`: real chown to an arbitrary PUID:PGID would fail
    // without root, so replace it with one that just logs its argv.
    await Deno.writeTextFile(
      join(binDir, "chown"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(chownLog)}\n`,
      { mode: 0o755 },
    )

    const script = generateVolumeCreationScript([weirdPath], "1000", "1000", false)
    const previousPath = Deno.env.get("PATH") ?? ""
    Deno.env.set("PATH", `${binDir}:${previousPath}`)
    let result: Deno.CommandOutput
    try {
      const proc = new Deno.Command("sh", {
        args: ["-c", script],
        stdout: "piped",
        stderr: "piped",
      })
      result = await proc.output()
    } finally {
      Deno.env.set("PATH", previousPath)
    }
    if (!result.success) {
      console.error(new TextDecoder().decode(result.stderr))
    }
    assertEquals(result.success, true)

    // The real mkdir created a directory with the exact literal weird
    // name — proves the value reached mkdir as one untouched argument.
    const createdInfo = await Deno.stat(weirdPath)
    assertEquals(createdInfo.isDirectory, true)

    // $(touch .../INJECTED) never ran as a command substitution.
    const injected = await Deno.stat(join(tmp, "INJECTED")).catch(() => null)
    assertEquals(injected, null, "the embedded $(...) must never execute")

    // chown also received the literal path, unmangled.
    const chownCalls = await Deno.readTextFile(chownLog)
    assertStringIncludes(chownCalls, weirdPath)
  } finally {
    await Deno.remove(tmp, { recursive: true })
    await Deno.remove(binDir, { recursive: true })
  }
})

Deno.test("extractVolumePaths refuses a volume path with a .. component", () => {
  const compose = [`- \${VOLUMES_PATH}/../../etc:/x`]
  const err = assertThrows(
    () => extractVolumePaths(compose, { VOLUMES_PATH: "/srv/volumes" }),
    UserError,
  )
  assertStringIncludes(err.message, `"/srv/volumes/../../etc" contains a ".." component`)
})

Deno.test("extractVolumePaths refuses a .. that only appears after expanding a variable", () => {
  const compose = [`- \${VOLUMES_PATH}/\${SUB}:/x`]
  assertThrows(
    () => extractVolumePaths(compose, { VOLUMES_PATH: "/srv/volumes", SUB: "app/../../../etc" }),
    UserError,
    `contains a ".." component`,
  )
})

Deno.test("extractVolumePaths refuses a path that normalises to VOLUMES_PATH itself", () => {
  const compose = [`- \${VOLUMES_PATH}/.:/x`]
  assertThrows(
    () => extractVolumePaths(compose, { VOLUMES_PATH: "/srv/volumes" }),
    UserError,
    `is not a subfolder of VOLUMES_PATH (/srv/volumes)`,
  )
})

Deno.test("extractVolumePaths accepts a path with . and doubled slashes that stays inside", () => {
  const compose = [`- \${VOLUMES_PATH}/./app//data:/x`]
  const paths = extractVolumePaths(compose, { VOLUMES_PATH: "/srv/volumes" })
  assertEquals(paths, ["/srv/volumes/./app//data"])
})

/**
 * Run a generated volume script under /bin/sh with a fake `sudo` first
 * on PATH. The fake only logs its argv and exits with FAKE_SUDO_EXIT
 * (default 0); it never runs the command it was given, and never calls
 * another binary. A depth guard stops it from ever running inside
 * itself. `stat`, `[` and everything else are the host's real tools.
 */
async function runWithFakeSudo(
  script: string,
  fakeSudoExit = 0,
): Promise<{ success: boolean; sudoCalls: string[]; stderr: string }> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-sudo-" })
  const log = join(binDir, "sudo.log")
  try {
    await Deno.writeTextFile(
      join(binDir, "sudo"),
      `#!/bin/sh
if [ -n "\${FAKE_SUDO_DEPTH:-}" ]; then exit 97; fi
FAKE_SUDO_DEPTH=1; export FAKE_SUDO_DEPTH
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
exit \${FAKE_SUDO_EXIT:-0}
`,
      { mode: 0o755 },
    )
    const out = await new Deno.Command("/bin/sh", {
      args: ["-c", script],
      env: {
        PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
        FAKE_SUDO_EXIT: String(fakeSudoExit),
      },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output()
    const text = await Deno.readTextFile(log).catch(() => "")
    return {
      success: out.success,
      sudoCalls: text.split("\n").filter((l) => l !== ""),
      stderr: new TextDecoder().decode(out.stderr),
    }
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
}

/**
 * The uid and gid that own `dir`: this test process's own, read from a
 * folder it just created (Deno.uid() would need --allow-sys).
 */
async function ownerOf(dir: string): Promise<{ uid: string; gid: string }> {
  const info = await Deno.stat(dir)
  return { uid: String(info.uid), gid: String(info.gid) }
}

Deno.test("generateVolumeCreationScript: a non-root user never runs sudo for a folder it already owns", async () => {
  const dir = await Deno.makeTempDir({ prefix: "rostok-volumes-owned-" })
  try {
    const { uid, gid } = await ownerOf(dir)
    const script = generateVolumeCreationScript([dir], uid, gid, true)
    const result = await runWithFakeSudo(script)
    assertEquals(result.success, true, result.stderr)
    assertEquals(result.sudoCalls, [])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("generateVolumeCreationScript: a missing folder is still created and chowned with sudo", async () => {
  const parent = await Deno.makeTempDir({ prefix: "rostok-volumes-missing-" })
  try {
    const missing = join(parent, "app")
    const { uid, gid } = await ownerOf(parent)
    const script = generateVolumeCreationScript([missing], uid, gid, true)
    const result = await runWithFakeSudo(script)
    assertEquals(result.success, true, result.stderr)
    assertEquals(result.sudoCalls, [
      `-n mkdir -p -- ${missing}`,
      `-n chown -R ${uid}:${gid} -- ${missing}`,
    ])
  } finally {
    await Deno.remove(parent, { recursive: true })
  }
})

Deno.test("generateVolumeCreationScript: a folder owned by someone else is chowned with sudo", async () => {
  const dir = await Deno.makeTempDir({ prefix: "rostok-volumes-foreign-" })
  try {
    // The folder belongs to this test's own user; asking for a different
    // PUID makes it "owned by someone else" without needing root.
    const { uid, gid } = await ownerOf(dir)
    const otherUid = String(Number(uid) + 1)
    const script = generateVolumeCreationScript([dir], otherUid, gid, true)
    const result = await runWithFakeSudo(script)
    assertEquals(result.success, true, result.stderr)
    assertEquals(result.sudoCalls, [
      `-n mkdir -p -- ${dir}`,
      `-n chown -R ${otherUid}:${gid} -- ${dir}`,
    ])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("generateVolumeCreationScript: a failed sudo fails the script and stops before the next folder", async () => {
  const parent = await Deno.makeTempDir({ prefix: "rostok-volumes-fail-" })
  try {
    const first = join(parent, "a")
    const second = join(parent, "b")
    const { uid, gid } = await ownerOf(parent)
    const script = generateVolumeCreationScript([first, second], uid, gid, true)
    const result = await runWithFakeSudo(script, 1)
    assertEquals(result.success, false)
    // Only the first folder's mkdir ran: its failure skipped its own
    // chown and every command for the second folder.
    assertEquals(result.sudoCalls, [`-n mkdir -p -- ${first}`])
  } finally {
    await Deno.remove(parent, { recursive: true })
  }
})
