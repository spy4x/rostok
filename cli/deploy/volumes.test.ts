import { assertEquals, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { extractVolumePaths, generateVolumeCreationScript } from "./volumes.ts"

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
  assertStringIncludes(script, "sudo -n mkdir -p '/volumes/app'")
  assertStringIncludes(script, "sudo -n chown -R '1000':'1000' '/volumes/app'")
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
