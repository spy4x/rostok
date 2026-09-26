import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import { join } from "@std/path"
import {
  extractVolumePaths,
  generateVolumeCreationScript,
  loadStackFileMounts,
  type VolumeScriptOptions,
} from "./volumes.ts"
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

/** `sh` or `zsh`: ssh runs the script through the remote user's login shell, often zsh. */
type Shell = "sh" | "zsh"
const SHELLS: Shell[] = ["sh", "zsh"]

interface ScriptRun {
  success: boolean
  stderr: string
  /** Argv of every `sudo` call, one line each. */
  sudoCalls: string[]
  /** Argv of every `chown` call, one line each. */
  chownCalls: string[]
}

/**
 * Run a generated volume script under `shell` (zsh gets `-f`, so the
 * developer's own zsh config never changes the result) with a fake
 * `sudo` and a fake `chown` first on PATH. Both fakes only log their
 * argv: sudo exits with FAKE_SUDO_EXIT (default 0) and never runs the
 * command it was given, chown changes nothing. Neither calls another
 * binary, and a depth guard stops either from running inside itself.
 * `mkdir`, `stat`, `[` and everything else are the host's real tools.
 */
async function runScript(
  script: string,
  shell: Shell = "sh",
  fakeSudoExit = 0,
): Promise<ScriptRun> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-bin-" })
  try {
    for (const name of ["sudo", "chown"]) {
      await Deno.writeTextFile(
        join(binDir, name),
        `#!/bin/sh
if [ -n "\${FAKE_BIN_DEPTH:-}" ]; then exit 97; fi
FAKE_BIN_DEPTH=1; export FAKE_BIN_DEPTH
printf '%s\\n' "$*" >> ${JSON.stringify(join(binDir, `${name}.log`))}
${name === "sudo" ? "exit ${FAKE_SUDO_EXIT:-0}" : "exit 0"}
`,
        { mode: 0o755 },
      )
    }
    const out = await new Deno.Command(shell === "zsh" ? "zsh" : "/bin/sh", {
      args: shell === "zsh" ? ["-f", "-c", script] : ["-c", script],
      env: {
        PATH: `${binDir}:${Deno.env.get("PATH") ?? ""}`,
        FAKE_SUDO_EXIT: String(fakeSudoExit),
      },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output()
    const readLog = async (name: string) =>
      (await Deno.readTextFile(join(binDir, `${name}.log`)).catch(() => ""))
        .split("\n").filter((l) => l !== "")
    return {
      success: out.success,
      stderr: new TextDecoder().decode(out.stderr),
      sudoCalls: await readLog("sudo"),
      chownCalls: await readLog("chown"),
    }
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
}

/** Script options with test defaults: root (no sudo), uid/gid 1000, no file mounts. */
function opts(
  volumesPath: string,
  volumePaths: string[],
  extra: Partial<VolumeScriptOptions> = {},
) {
  return {
    volumesPath,
    volumePaths,
    fileMounts: [],
    puid: "1000",
    pgid: "1000",
    needsSudo: false,
    ...extra,
  }
}

async function exists(path: string): Promise<boolean> {
  return await Deno.lstat(path).then(() => true, () => false)
}

/**
 * The uid and gid that own `dir`: this test process's own, read from a
 * folder it just created (Deno.uid() would need --allow-sys).
 */
async function ownerOf(dir: string): Promise<{ uid: string; gid: string }> {
  const info = await Deno.stat(dir)
  return { uid: String(info.uid), gid: String(info.gid) }
}

/** A fresh temp dir, resolved (so `/tmp` being a symlink never skews a path comparison). */
async function tempRoot(prefix: string): Promise<string> {
  return await Deno.realPath(await Deno.makeTempDir({ prefix }))
}

Deno.test("generateVolumeCreationScript chowns to PUID:PGID, not a user name", async () => {
  const root = await tempRoot("rostok-volumes-owner-")
  try {
    const result = await runScript(generateVolumeCreationScript(opts(root, [`${root}/app`], {
      puid: "1234",
      pgid: "5678",
    })))
    assertEquals(result.success, true, result.stderr)
    assertEquals(result.chownCalls, [`-R 1234:5678 -- ${root}/app`])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("generateVolumeCreationScript never hides a failure", () => {
  const script = generateVolumeCreationScript(opts("/volumes", ["/volumes/app/data"]))
  assertEquals(script.includes("|| true"), false)
  assertEquals(script.includes("2>/dev/null"), false)
})

Deno.test("generateVolumeCreationScript: no sudo when the remote is already root", async () => {
  const root = await tempRoot("rostok-volumes-root-")
  try {
    const result = await runScript(generateVolumeCreationScript(opts(root, [`${root}/app`])))
    assertEquals(result.success, true, result.stderr)
    assertEquals(result.sudoCalls, [])
    assertEquals((await Deno.stat(`${root}/app`)).isDirectory, true)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

for (const shell of SHELLS) {
  Deno.test(`generateVolumeCreationScript (${shell}): creates and chowns every normal path, in order`, async () => {
    const root = await tempRoot("rostok-volumes-normal-")
    try {
      const paths = [`${root}/a/data`, `${root}/b`]
      const result = await runScript(generateVolumeCreationScript(opts(root, paths)), shell)
      assertEquals(result.success, true, result.stderr)
      assertEquals(result.chownCalls, paths.map((p) => `-R 1000:1000 -- ${p}`))
      for (const p of paths) assertEquals((await Deno.stat(p)).isDirectory, true)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  Deno.test(`generateVolumeCreationScript (${shell}): a VOLUMES_PATH that is itself a symlink still works`, async () => {
    const root = await tempRoot("rostok-volumes-baselink-")
    try {
      await Deno.mkdir(`${root}/disk`)
      await Deno.symlink(`${root}/disk`, `${root}/volumes`)
      const script = generateVolumeCreationScript(opts(`${root}/volumes`, [`${root}/volumes/app`]))
      const result = await runScript(script, shell)
      assertEquals(result.success, true, result.stderr)
      assertEquals(result.chownCalls, [`-R 1000:1000 -- ${root}/disk/app`])
      assertEquals((await Deno.stat(`${root}/disk/app`)).isDirectory, true)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  Deno.test(`generateVolumeCreationScript (${shell}): a middle folder that is a symlink out of VOLUMES_PATH is refused before any mkdir or chown`, async () => {
    const root = await tempRoot("rostok-volumes-escape-")
    try {
      await Deno.mkdir(`${root}/volumes`)
      await Deno.mkdir(`${root}/outside`)
      await Deno.symlink(`${root}/outside`, `${root}/volumes/app`)
      const script = generateVolumeCreationScript(
        opts(`${root}/volumes`, [`${root}/volumes/app/data`]),
      )
      const result = await runScript(script, shell)
      assertEquals(result.success, false)
      assertStringIncludes(result.stderr, `resolves to ${root}/outside/data, outside VOLUMES_PATH`)
      assertEquals(await exists(`${root}/outside/data`), false, "mkdir ran outside VOLUMES_PATH")
      assertEquals(result.chownCalls, [])
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  Deno.test(`generateVolumeCreationScript (${shell}): as non-root, a symlinked middle folder never reaches sudo`, async () => {
    const root = await tempRoot("rostok-volumes-escape-sudo-")
    try {
      await Deno.mkdir(`${root}/volumes`)
      await Deno.mkdir(`${root}/outside`)
      await Deno.symlink(`${root}/outside`, `${root}/volumes/app`)
      const script = generateVolumeCreationScript(
        opts(`${root}/volumes`, [`${root}/volumes/app/data`], { needsSudo: true }),
      )
      const result = await runScript(script, shell)
      assertEquals(result.success, false)
      assertStringIncludes(result.stderr, "outside VOLUMES_PATH")
      assertEquals(result.sudoCalls, [])
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  Deno.test(`generateVolumeCreationScript (${shell}): a last folder that is a symlink out of VOLUMES_PATH is never chowned`, async () => {
    const root = await tempRoot("rostok-volumes-lastlink-")
    try {
      await Deno.mkdir(`${root}/volumes`)
      await Deno.mkdir(`${root}/outside`)
      await Deno.symlink(`${root}/outside`, `${root}/volumes/app`)
      const script = generateVolumeCreationScript(opts(`${root}/volumes`, [`${root}/volumes/app`]))
      const result = await runScript(script, shell)
      assertEquals(result.success, false)
      assertStringIncludes(result.stderr, `resolves to ${root}/outside, outside VOLUMES_PATH`)
      assertEquals(result.chownCalls, [])
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  Deno.test(`generateVolumeCreationScript (${shell}): a broken symlink partway along the path is refused`, async () => {
    const root = await tempRoot("rostok-volumes-dangling-")
    try {
      await Deno.mkdir(`${root}/volumes`)
      await Deno.symlink(`${root}/missing`, `${root}/volumes/app`)
      const script = generateVolumeCreationScript(
        opts(`${root}/volumes`, [`${root}/volumes/app/data`]),
      )
      const result = await runScript(script, shell)
      assertEquals(result.success, false)
      assertStringIncludes(result.stderr, "is not a folder")
      assertEquals(await exists(`${root}/missing`), false, "mkdir followed the broken symlink")
      assertEquals(result.chownCalls, [])
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  Deno.test(`generateVolumeCreationScript (${shell}): a symlink that stays inside VOLUMES_PATH is followed, and the resolved folder is chowned`, async () => {
    const root = await tempRoot("rostok-volumes-innerlink-")
    try {
      await Deno.mkdir(`${root}/volumes/real`, { recursive: true })
      await Deno.symlink(`${root}/volumes/real`, `${root}/volumes/app`)
      const script = generateVolumeCreationScript(
        opts(`${root}/volumes`, [`${root}/volumes/app/data`]),
      )
      const result = await runScript(script, shell)
      assertEquals(result.success, true, result.stderr)
      assertEquals(result.chownCalls, [`-R 1000:1000 -- ${root}/volumes/real/data`])
      assertEquals((await Deno.stat(`${root}/volumes/real/data`)).isDirectory, true)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  Deno.test(`generateVolumeCreationScript (${shell}): a file mount that is already a file is never mkdir'd, chowned or sudo'd`, async () => {
    const root = await tempRoot("rostok-volumes-filemount-")
    try {
      const dir = `${root}/traefik/letsencrypt`
      const acme = `${dir}/acme.json`
      await Deno.mkdir(dir, { recursive: true })
      await Deno.writeTextFile(acme, "{}")
      const { uid, gid } = await ownerOf(dir)
      for (const needsSudo of [false, true]) {
        const script = generateVolumeCreationScript(
          opts(root, [dir, acme], { fileMounts: [acme], puid: uid, pgid: gid, needsSudo }),
        )
        const result = await runScript(script, shell)
        assertEquals(result.success, true, result.stderr)
        assertEquals(result.sudoCalls, [])
        assertEquals(result.chownCalls, needsSudo ? [] : [`-R ${uid}:${gid} -- ${dir}`])
        assertEquals((await Deno.stat(acme)).isFile, true)
      }
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  Deno.test(`generateVolumeCreationScript (${shell}): a missing file mount fails before anything is created, and no acme.json folder appears`, async () => {
    const root = await tempRoot("rostok-volumes-nofile-")
    try {
      const acme = `${root}/traefik/letsencrypt/acme.json`
      const script = generateVolumeCreationScript(
        opts(root, [`${root}/app`, acme], { fileMounts: [acme] }),
      )
      const result = await runScript(script, shell)
      assertEquals(result.success, false)
      assertStringIncludes(result.stderr, `file mount ${acme} does not exist yet`)
      assertEquals(await exists(acme), false, "a folder named acme.json was created")
      assertEquals(await exists(`${root}/app`), false, "a folder was created before the check")
      assertEquals(result.chownCalls, [])
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })

  Deno.test(`generateVolumeCreationScript (${shell}): a folder where a file mount belongs is reported`, async () => {
    const root = await tempRoot("rostok-volumes-dirfile-")
    try {
      const acme = `${root}/traefik/letsencrypt/acme.json`
      await Deno.mkdir(acme, { recursive: true })
      const script = generateVolumeCreationScript(opts(root, [acme], { fileMounts: [acme] }))
      const result = await runScript(script, shell)
      assertEquals(result.success, false)
      assertStringIncludes(result.stderr, `file mount ${acme} exists but is not a regular file`)
      assertEquals(result.chownCalls, [])
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })
}

Deno.test("generateVolumeCreationScript: a file mount matches its volume path after normalising slashes", () => {
  const script = generateVolumeCreationScript(
    opts("/v", ["/v/./traefik//acme.json"], { fileMounts: ["/v/traefik/acme.json"] }),
  )
  assertStringIncludes(script, "rostok_file '/v/./traefik//acme.json'")
  assertEquals(script.includes("rostok_resolve '/v/./traefik//acme.json'"), false)
})

Deno.test("generateVolumeCreationScript: a path with $(), \" and ' never executes as a command", async () => {
  // Real end-to-end proof, not a string match: build a path that contains
  // shell metacharacters, run the generated script for real, and confirm
  // mkdir/chown received the LITERAL path (no substitution ran). A
  // double-quoted version (`mkdir -p "$path"`) would let `$(...)` run.
  const root = await tempRoot("rostok-volumes-inject-")
  try {
    const weirdPath = join(root, `weird$(touch ${root}/INJECTED)"quote'quote`)
    const result = await runScript(generateVolumeCreationScript(opts(root, [weirdPath])))
    assertEquals(result.success, true, result.stderr)
    assertEquals((await Deno.stat(weirdPath)).isDirectory, true)
    assertEquals(await exists(join(root, "INJECTED")), false, "the embedded $(...) ran")
    assertEquals(result.chownCalls, [`-R 1000:1000 -- ${weirdPath}`])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("generateVolumeCreationScript: a non-root user never runs sudo for a folder it already owns", async () => {
  const root = await tempRoot("rostok-volumes-owned-")
  try {
    await Deno.mkdir(`${root}/app`)
    const { uid, gid } = await ownerOf(`${root}/app`)
    const script = generateVolumeCreationScript(
      opts(root, [`${root}/app`], { puid: uid, pgid: gid, needsSudo: true }),
    )
    const result = await runScript(script)
    assertEquals(result.success, true, result.stderr)
    assertEquals(result.sudoCalls, [])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("generateVolumeCreationScript: a missing folder is still created and chowned with sudo", async () => {
  const root = await tempRoot("rostok-volumes-missing-")
  try {
    const missing = join(root, "app")
    const { uid, gid } = await ownerOf(root)
    const script = generateVolumeCreationScript(
      opts(root, [missing], { puid: uid, pgid: gid, needsSudo: true }),
    )
    const result = await runScript(script)
    assertEquals(result.success, true, result.stderr)
    assertEquals(result.sudoCalls, [
      `-n mkdir -p -- ${missing}`,
      `-n chown -R ${uid}:${gid} -- ${missing}`,
    ])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("generateVolumeCreationScript: a folder owned by someone else is chowned with sudo", async () => {
  const root = await tempRoot("rostok-volumes-foreign-")
  try {
    const dir = join(root, "app")
    await Deno.mkdir(dir)
    // The folder belongs to this test's own user; asking for a different
    // PUID makes it "owned by someone else" without needing root.
    const { uid, gid } = await ownerOf(dir)
    const otherUid = String(Number(uid) + 1)
    const script = generateVolumeCreationScript(
      opts(root, [dir], { puid: otherUid, pgid: gid, needsSudo: true }),
    )
    const result = await runScript(script)
    assertEquals(result.success, true, result.stderr)
    assertEquals(result.sudoCalls, [
      `-n mkdir -p -- ${dir}`,
      `-n chown -R ${otherUid}:${gid} -- ${dir}`,
    ])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("generateVolumeCreationScript: the ownership check compares uid first, then gid", async () => {
  const root = await tempRoot("rostok-volumes-uidgid-")
  try {
    const dir = join(root, "app")
    await Deno.mkdir(dir)
    const { uid, gid } = await ownerOf(dir)
    // uid and gid swapped: only an owner check that keeps their order
    // tells this apart from the folder's real owner (when they differ).
    const swapped = generateVolumeCreationScript(
      opts(root, [dir], { puid: gid, pgid: uid, needsSudo: true }),
    )
    const result = await runScript(swapped)
    assertEquals(result.success, true, result.stderr)
    assertEquals(result.sudoCalls.length, uid === gid ? 0 : 2)
    assertStringIncludes(swapped, `"$(stat -c %u:%g -- "$rostok_real")" = '${gid}':'${uid}'`)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("generateVolumeCreationScript: a failed sudo fails the script and stops before the next folder", async () => {
  const root = await tempRoot("rostok-volumes-fail-")
  try {
    const first = join(root, "a")
    const second = join(root, "b")
    const { uid, gid } = await ownerOf(root)
    const script = generateVolumeCreationScript(
      opts(root, [first, second], { puid: uid, pgid: gid, needsSudo: true }),
    )
    const result = await runScript(script, "sh", 1)
    assertEquals(result.success, false)
    // Only the first folder's mkdir ran: its failure skipped its own
    // chown and every command for the second folder.
    assertEquals(result.sudoCalls, [`-n mkdir -p -- ${first}`])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("generateVolumeCreationScript: a missing VOLUMES_PATH fails before anything is created", async () => {
  const root = await tempRoot("rostok-volumes-nobase-")
  try {
    const script = generateVolumeCreationScript(opts(`${root}/volumes`, [`${root}/volumes/app`]))
    const result = await runScript(script)
    assertEquals(result.success, false)
    assertEquals(await exists(`${root}/volumes`), false)
    assertEquals(result.chownCalls, [])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("loadStackFileMounts reads fileMounts from a local +meta.ts", async () => {
  const dir = await tempRoot("rostok-volumes-meta-")
  try {
    await Deno.writeTextFile(
      join(dir, "+meta.ts"),
      `export default { name: "demo", description: "d", variables: [], ` +
        `fileMounts: ["traefik/letsencrypt/acme.json"] }\n`,
    )
    const files = new Map([["+meta.ts", `file://${dir}/+meta.ts`]])
    assertEquals(await loadStackFileMounts("demo", files), ["traefik/letsencrypt/acme.json"])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("loadStackFileMounts: a stack with no +meta.ts anywhere has no file mounts", async () => {
  assertEquals(await loadStackFileMounts("not-a-catalog-stack", new Map()), [])
})

Deno.test("loadStackFileMounts: a broken local +meta.ts of a non-catalog stack is a clear error", async () => {
  const dir = await tempRoot("rostok-volumes-badmeta-")
  try {
    await Deno.writeTextFile(join(dir, "+meta.ts"), `export default { name: "" }\n`)
    const files = new Map([["+meta.ts", `file://${dir}/+meta.ts`]])
    const err = await loadStackFileMounts("demo", files).then(() => null, (e) => e)
    assert(err instanceof UserError, `expected a UserError, got ${err}`)
    assertStringIncludes(err.message, "could not load stacks/demo/+meta.ts")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("the mirotalk and stalwart stacks declare traefik's acme.json as a file mount", async () => {
  for (const stack of ["mirotalk", "stalwart"]) {
    const url = new URL(`../../stacks/${stack}/+meta.ts`, import.meta.url).href
    const mounts = await loadStackFileMounts(stack, new Map([["+meta.ts", url]]))
    assertEquals(mounts, ["traefik/letsencrypt/acme.json"], stack)
  }
})
