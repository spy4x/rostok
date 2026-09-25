import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { UserError } from "../errors.ts"
import {
  buildPathsCheckScript,
  checkDockerGroup,
  checkRemotePathsNotNested,
  needsRemoteSudo,
} from "./docker-preflight.ts"

/** Install a fake `ssh` on PATH that prints `sshReply` to stdout and exits 0. */
async function withFakeSsh<T>(sshReply: string, fn: () => Promise<T>): Promise<T> {
  return await withFakeSshScript(`printf '%s' ${shQuote(sshReply)}\n`, fn)
}

/** Install a fake `ssh` that simulates its own connection-level failure: prints `message` to stderr and exits 255. */
async function withUnreachableFakeSsh<T>(message: string, fn: () => Promise<T>): Promise<T> {
  return await withFakeSshScript(`printf '%s' ${shQuote(message)} >&2\nexit 255\n`, fn)
}

async function withFakeSshScript<T>(scriptBody: string, fn: () => Promise<T>): Promise<T> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-ssh-" })
  try {
    const script = `#!/bin/sh\n${scriptBody}`
    await Deno.writeTextFile(join(binDir, "ssh"), script, { mode: 0o755 })
    const previousPath = Deno.env.get("PATH") ?? ""
    Deno.env.set("PATH", `${binDir}:${previousPath}`)
    try {
      return await fn()
    } finally {
      Deno.env.set("PATH", previousPath)
    }
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

Deno.test("checkDockerGroup: passes when the remote GID matches", async () => {
  await withFakeSsh("docker:x:988:\n", async () => {
    await checkDockerGroup("root@example.com", "988", "servers/home/.env")
  })
})

Deno.test("checkDockerGroup: throws naming both GIDs and the file on mismatch", async () => {
  await withFakeSsh("docker:x:988:\n", async () => {
    const err = await assertRejects(
      () => checkDockerGroup("root@example.com", "990", "servers/home/.env"),
      UserError,
    )
    assertStringIncludes(err.message, "990")
    assertStringIncludes(err.message, "988")
    assertStringIncludes(err.message, "servers/home/.env")
  })
})

Deno.test("checkDockerGroup: throws when the docker group is missing", async () => {
  await withFakeSsh("", async () => {
    const err = await assertRejects(
      () => checkDockerGroup("root@example.com", "988", "servers/home/.env"),
      UserError,
    )
    assertStringIncludes(err.message, "docker group not found")
  })
})

Deno.test("needsRemoteSudo: false when the remote id -u is 0 (already root)", async () => {
  await withFakeSsh("0\n", async () => {
    const result = await needsRemoteSudo("root@example.com")
    assertEquals(result, false)
  })
})

Deno.test("needsRemoteSudo: true when the remote id -u is not 0", async () => {
  await withFakeSsh("1000\n", async () => {
    const result = await needsRemoteSudo("deploy@example.com")
    assertEquals(result, true)
  })
})

Deno.test("needsRemoteSudo: throws when id -u can't be read", async () => {
  await withFakeSsh("", async () => {
    const err = await assertRejects(
      () => needsRemoteSudo("root@example.com"),
      UserError,
    )
    assertStringIncludes(err.message, "id -u")
  })
})

Deno.test("checkDockerGroup: names the step and says the server is unreachable, not a missing docker group (#10)", async () => {
  // ssh's own connection-level failures (dead host, timeout, refused,
  // no DNS) always exit 255 — before this fix, that surfaced as the
  // misleading "docker group not found on root@192.0.2.1", which reads
  // like Docker isn't installed rather than "the server didn't answer".
  await withUnreachableFakeSsh(
    "ssh: connect to host 192.0.2.1 port 22: Connection timed out",
    async () => {
      const err = await assertRejects(
        () => checkDockerGroup("root@192.0.2.1", "988", "servers/home/.env"),
        UserError,
      )
      assertStringIncludes(err.message, "can't reach root@192.0.2.1 over SSH")
      assertStringIncludes(err.message, "checking the docker group")
      assertStringIncludes(err.message, "Connection timed out")
      assertEquals(err.message.includes("docker group not found"), false)
    },
  )
})

Deno.test("checkRemotePathsNotNested: passes when the real, resolved paths are siblings and stacks/ resolves correctly", async () => {
  await withFakeSsh("/srv/apps\n/srv/volumes\n/srv/apps/stacks\n", async () => {
    await checkRemotePathsNotNested("root@example.com", "/srv/apps", "/srv/volumes")
  })
})

Deno.test("checkRemotePathsNotNested: refuses when a SYMLINK makes the real paths nest, even though the .env strings look like siblings (#233 review)", async () => {
  // The .env values themselves ("/srv/apps", "/srv/volumes") never
  // nest — only `readlink -f` on the actual server reveals that
  // VOLUMES_PATH is secretly a symlink pointing inside PATH_APPS. A
  // string-only comparison (env.ts's own pathsNestedOrEqual check)
  // can't catch this; only asking the real server can.
  await withFakeSsh("/srv/apps\n/srv/apps/.volumes\n/srv/apps/stacks\n", async () => {
    const err = await assertRejects(
      () => checkRemotePathsNotNested("root@example.com", "/srv/apps", "/srv/volumes"),
      UserError,
    )
    assertStringIncludes(err.message, "/srv/apps")
    assertStringIncludes(err.message, "/srv/apps/.volumes")
    assertStringIncludes(err.message, "readlink -f")
  })
})

Deno.test("checkRemotePathsNotNested: refuses when PATH_APPS/stacks resolves elsewhere — a symlinked stacks/ into VOLUMES_PATH (review round)", async () => {
  // PATH_APPS and VOLUMES_PATH themselves are still genuine siblings —
  // only the stacks/ FOLDER has been replaced with a symlink pointing
  // into VOLUMES_PATH. Every stale-stack removal and per-stack sync
  // runs under PATH_APPS/stacks, so this must be caught even though the
  // first (PATH_APPS vs VOLUMES_PATH) check alone would pass.
  await withFakeSsh(
    "/srv/apps\n/srv/volumes\n/srv/volumes/actual-data\n",
    async () => {
      const err = await assertRejects(
        () => checkRemotePathsNotNested("root@example.com", "/srv/apps", "/srv/volumes"),
        UserError,
      )
      assertStringIncludes(err.message, "PATH_APPS/stacks")
      assertStringIncludes(err.message, "/srv/volumes/actual-data")
      assertStringIncludes(err.message, "/srv/apps/stacks")
    },
  )
})

Deno.test("buildPathsCheckScript: passes on a fresh server where BOTH parent directory levels are missing (review round)", async () => {
  // readlink -f (GNU and BusyBox, verified directly) exits 1 with no
  // output the moment any component before the last is missing — the
  // exact shape of a genuinely fresh server. This runs the REAL script
  // through a REAL sh, never a mock, so it actually proves the mkdir -p
  // fix, not just that the higher-level function parses canned output
  // correctly.
  const remoteRoot = await Deno.makeTempDir({ prefix: "rostok-preflight-fresh-test-" })
  try {
    const pathApps = join(remoteRoot, "fresh", "srv", "apps")
    const volumesPath = join(remoteRoot, "fresh", "srv", "volumes")
    // Neither "fresh" nor "fresh/srv" exists yet — two missing parent levels.
    const parentExists = await Deno.stat(join(remoteRoot, "fresh")).then(() => true).catch(() =>
      false
    )
    assertEquals(parentExists, false, "test bug: the fresh/ parent must not exist yet")

    const script = buildPathsCheckScript(pathApps, volumesPath)
    const proc = new Deno.Command("sh", { args: ["-c", script], stdout: "piped", stderr: "piped" })
    const out = await proc.output()
    const stdout = new TextDecoder().decode(out.stdout)
    const stderr = new TextDecoder().decode(out.stderr)
    assertEquals(out.success, true, `script failed: ${stderr}`)
    const [realPathApps, realVolumesPath, realStacksDir] = stdout.trim().split("\n")
    assertEquals(realPathApps, pathApps)
    assertEquals(realVolumesPath, volumesPath)
    assertEquals(realStacksDir, join(pathApps, "stacks"))
  } finally {
    await Deno.remove(remoteRoot, { recursive: true })
  }
})

Deno.test("checkRemotePathsNotNested: a path containing --- is parsed correctly, not split apart", async () => {
  await withFakeSsh("/srv/app---s\n/srv/volumes\n/srv/app---s/stacks\n", async () => {
    await checkRemotePathsNotNested("root@example.com", "/srv/app---s", "/srv/volumes")
  })
})

Deno.test("checkRemotePathsNotNested: refuses output that isn't exactly three absolute paths", async () => {
  // A resolved path holding a newline arrives as an extra line.
  await withFakeSsh("/srv/apps\n/srv/vol\numes\n/srv/apps/stacks\n", async () => {
    const err = await assertRejects(
      () => checkRemotePathsNotNested("root@example.com", "/srv/apps", "/srv/volumes"),
      UserError,
    )
    assertStringIncludes(err.message, "exactly one absolute path")
  })
})

Deno.test("buildPathsCheckScript: creates VOLUMES_PATH with sudo -n only when the remote user needs it", () => {
  const withSudo = buildPathsCheckScript("/srv/apps", "/srv/volumes", true)
  assertStringIncludes(withSudo, "sudo -n mkdir -p -- '/srv/volumes'")
  assertStringIncludes(withSudo, "mkdir -p -- '/srv/apps' '/srv/apps/stacks' && ")
  assertEquals(withSudo.split("sudo").length - 1, 1, "only VOLUMES_PATH gets sudo")
  assertEquals(buildPathsCheckScript("/srv/apps", "/srv/volumes").includes("sudo"), false)
})

Deno.test("checkRemotePathsNotNested: names the step and says the server is unreachable on a connection failure", async () => {
  await withUnreachableFakeSsh(
    "ssh: connect to host 192.0.2.1 port 22: Connection timed out",
    async () => {
      const err = await assertRejects(
        () => checkRemotePathsNotNested("root@192.0.2.1", "/srv/apps", "/srv/volumes"),
        UserError,
      )
      assertStringIncludes(err.message, "can't reach root@192.0.2.1 over SSH")
      assertStringIncludes(err.message, "resolving PATH_APPS/VOLUMES_PATH symlinks")
    },
  )
})

Deno.test("buildPathsCheckScript: skips sudo entirely when VOLUMES_PATH already exists (#243)", async () => {
  // The exact regression #243 reports: a non-root deploy user without
  // passwordless sudo, whose VOLUMES_PATH the operator already created,
  // must still be able to deploy. `sudo -n mkdir -p` used to run
  // unconditionally whenever needsSudo was true, which failed here even
  // though nothing needed creating. Runs the REAL script through a REAL
  // sh with NO `sudo` on PATH at all — the strongest possible proof that
  // this path never even tries to invoke it.
  const remoteRoot = await Deno.makeTempDir({ prefix: "rostok-preflight-existing-volumes-" })
  try {
    const pathApps = join(remoteRoot, "apps")
    const volumesPath = join(remoteRoot, "volumes")
    await Deno.mkdir(volumesPath, { recursive: true })
    const script = buildPathsCheckScript(pathApps, volumesPath, true)
    const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-sudo-denied-" })
    try {
      // A `sudo` that always fails, shadowing the real one — if the
      // `[ -d X ] ||` guard were ever removed, this would fail the
      // script even though VOLUMES_PATH already exists and nothing
      // needed creating.
      await Deno.writeTextFile(join(binDir, "sudo"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
      const proc = new Deno.Command("sh", {
        args: ["-c", script],
        env: { PATH: `${binDir}:/usr/bin:/bin` },
        stdout: "piped",
        stderr: "piped",
      })
      const out = await proc.output()
      const stderr = new TextDecoder().decode(out.stderr)
      assertEquals(out.success, true, `script failed with sudo denied: ${stderr}`)
    } finally {
      await Deno.remove(binDir, { recursive: true })
    }
  } finally {
    await Deno.remove(remoteRoot, { recursive: true })
  }
})

Deno.test("buildPathsCheckScript: a failed sudo mkdir aborts the script, never reaches readlink (#243, `;` vs `&&`)", async () => {
  // If the join between the sudo mkdir and the rest of the script were
  // `;` instead of `&&`, a denied `sudo -n` (no passwordless rule, and
  // the directory is genuinely missing) would be swallowed and the
  // script would go on to `readlink -f` a path that was never created —
  // reporting a confusing resolve failure instead of the real
  // permission error, or worse, succeeding against a wrong parent.
  const remoteRoot = await Deno.makeTempDir({ prefix: "rostok-preflight-sudo-fail-" })
  try {
    const pathApps = join(remoteRoot, "apps")
    const volumesPath = join(remoteRoot, "volumes") // deliberately never created
    const script = buildPathsCheckScript(pathApps, volumesPath, true)
    const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-sudo-" })
    try {
      // A `sudo` that always fails, simulating "no passwordless rule".
      await Deno.writeTextFile(join(binDir, "sudo"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
      const proc = new Deno.Command("sh", {
        args: ["-c", script],
        env: { PATH: `${binDir}:/usr/bin:/bin` },
        stdout: "piped",
        stderr: "piped",
      })
      const out = await proc.output()
      const stdout = new TextDecoder().decode(out.stdout)
      assertEquals(out.success, false, "a denied sudo mkdir must fail the whole script")
      // Never reached readlink -f, so no resolved paths were printed.
      assertEquals(stdout.trim(), "")
    } finally {
      await Deno.remove(binDir, { recursive: true })
    }
  } finally {
    await Deno.remove(remoteRoot, { recursive: true })
  }
})

Deno.test("buildPathsCheckScript: a failed PATH_APPS mkdir still aborts the script even though VOLUMES_PATH needs sudo (#243, && vs || precedence)", async () => {
  // PATH_APPS's own `mkdir -p` fails here (a FILE already sits where a
  // directory is expected). Without the `( [ -d X ] || sudo ... )`
  // grouping, `&&`/`||` share one precedence level and associate left
  // to right: `mkdir1 && [ -d X ] || sudo ... && readlink...` parses as
  // `((mkdir1 && [ -d X ]) || sudo ...) && readlink...` — a failed
  // mkdir1 would still let `sudo mkdir` run and, if THAT succeeded,
  // the whole left side would read as true and readlink would run
  // against a PATH_APPS that was never actually created.
  const remoteRoot = await Deno.makeTempDir({ prefix: "rostok-preflight-mkdir-fail-" })
  try {
    const pathApps = join(remoteRoot, "apps")
    await Deno.writeTextFile(pathApps, "not a directory")
    const volumesPath = join(remoteRoot, "volumes")
    const script = buildPathsCheckScript(pathApps, volumesPath, true)
    const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-sudo-ok-" })
    try {
      // A `sudo` that always SUCCEEDS — the failure must come from
      // PATH_APPS's own mkdir, not from sudo being denied.
      await Deno.writeTextFile(
        join(binDir, "sudo"),
        '#!/bin/sh\nshift\nexec "$@"\n',
        { mode: 0o755 },
      )
      const proc = new Deno.Command("sh", {
        args: ["-c", script],
        env: { PATH: `${binDir}:/usr/bin:/bin` },
        stdout: "piped",
        stderr: "piped",
      })
      const out = await proc.output()
      const stdout = new TextDecoder().decode(out.stdout)
      assertEquals(
        out.success,
        false,
        "a failed PATH_APPS mkdir must fail the script even though the sudo branch succeeds",
      )
      assertEquals(stdout.trim(), "", `readlink must never have run, got: ${stdout}`)
    } finally {
      await Deno.remove(binDir, { recursive: true })
    }
  } finally {
    await Deno.remove(remoteRoot, { recursive: true })
  }
})

Deno.test("checkRemotePathsNotNested: refuses output where one line isn't absolute, even with exactly three lines", async () => {
  // The line-count check ("exactly three") and the absolute-path check
  // ("every line starts with /") are two separate conditions ORed
  // together — this proves the absolute-path half on its own, with the
  // line count already correct, so a mutation that dropped only the
  // `some(!startsWith("/"))` half would still be caught.
  await withFakeSsh("/srv/apps\nrelative/path\n/srv/apps/stacks\n", async () => {
    const err = await assertRejects(
      () => checkRemotePathsNotNested("root@example.com", "/srv/apps", "/srv/volumes"),
      UserError,
    )
    assertStringIncludes(err.message, "exactly one absolute path")
  })
})

Deno.test("checkRemotePathsNotNested: strips control characters from a resolved path before it reaches the refusal message (#243)", async () => {
  // readlink -f ran on the SERVER — a symlink target name planted there
  // can carry escape/bell bytes. The nested/equal refusal embeds the
  // resolved paths directly; they must never reach the operator's
  // terminal un-stripped.
  const planted = "/srv/apps/.vol\x1b]0;PWNED\x07ume"
  await withFakeSsh(`/srv/apps\n${planted}\n/srv/apps/stacks\n`, async () => {
    const err = await assertRejects(
      () => checkRemotePathsNotNested("root@example.com", "/srv/apps", "/srv/volumes"),
      UserError,
    )
    assertEquals(err.message.includes("\x1b"), false, err.message)
    assertEquals(err.message.includes("\x07"), false, err.message)
    assertStringIncludes(err.message, "/srv/apps/.vol]0;PWNEDume")
  })
})

Deno.test("needsRemoteSudo: names the step and says the server is unreachable, not a missing UID", async () => {
  await withUnreachableFakeSsh(
    "ssh: connect to host 192.0.2.1 port 22: Connection timed out",
    async () => {
      const err = await assertRejects(
        () => needsRemoteSudo("root@192.0.2.1"),
        UserError,
      )
      assertStringIncludes(err.message, "can't reach root@192.0.2.1 over SSH")
      assertStringIncludes(err.message, "checking the remote user's UID")
      assertEquals(err.message.includes("could not determine"), false)
    },
  )
})
