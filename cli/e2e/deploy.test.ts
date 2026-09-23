// End-to-end test for `rostok deploy` (#203 point 4).
//
// Walks the path a JSR-installed user is in: a project folder outside
// this repo, with no `stacks/` directory of its own — every stack file
// has to come from the CLI package's bundled catalog (cli/deploy/
// shipped-stacks.ts + stack-files.ts), never from `./stacks/` or
// `./scripts/`. Fake `ssh` and `rsync` binaries go first on PATH: they
// record what they're asked to do and `rsync` copies into a temp
// "remote" directory, so the test can assert on the exact files that
// reached it — including that `./scripts` and `./deno.jsonc` do NOT.
//
// If cli/deploy/shipped-stacks.ts under-lists a catalog stack's files
// (or run-deploy.ts fails to stage one), the corresponding assertion
// below fails.

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"

const FAKE_SSH = `#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
// Records every invocation to FAKE_SSH_LOG, then fakes just enough of a
// remote host for a deploy to complete: the docker-group + remote-UID
// preflights and the per-stack DEPLOY_START/DEPLOY_SUCCESS markers the
// real deploy script would print after a successful \`docker compose up\`.
// Anything else (proxy network, stale-stack cleanup, volume mkdir/chown)
// is accepted silently, matching a healthy remote.
//
// Every real call is \`ssh -o ConnectTimeout=10 [-o BatchMode=yes] [-p <port>]
// -- <target> <command...>\` (cli/deploy/exec.ts's sshArgs, see
// cli/server-keys.ts) — the target and command sit right after the
// first \`--\`, wherever the options before it land.
const args = Deno.args
const dashDashIdx = args.indexOf("--")
const script = args.slice(dashDashIdx + 2).join(" ")
const logPath = Deno.env.get("FAKE_SSH_LOG")
if (logPath) {
  await Deno.writeTextFile(logPath, script + "\\n---\\n", { append: true })
}
// FAKE_SSH_UNREACHABLE simulates a dead/unreachable server. A real ssh
// enforces -o ConnectTimeout=10 itself, so this fake only needs to
// check the flag is actually in argv: present -> fail immediately the
// way ssh does on a real timeout (proving the wiring works, without
// spending 10 real seconds on it); ABSENT -> really hang, the way an
// unreachable host would without that flag, so a regression that drops
// ConnectTimeout turns this test red instead of quietly slow.
if (Deno.env.get("FAKE_SSH_UNREACHABLE")) {
  if (args.includes("ConnectTimeout=10")) {
    console.error("ssh: connect to host remote.test port 22: Connection timed out")
    Deno.exit(255)
  }
  // No ConnectTimeout in argv: really hang, the way an unreachable host
  // would. Killing the top-level "deno run mainTs" test subprocess
  // doesn't necessarily reach THIS grandchild (Deno.Command exposes no
  // process-group kill), so this gets its own hard deadline — 20s, well
  // past every test's own bounded wait — instead of relying only on
  // being killed from outside.
  setTimeout(() => Deno.exit(1), 20_000)
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
// FAKE_SSH_HANG_ON hangs forever the first time \`script\` contains this
// text — used to hold a deploy open mid-run so a test can send it a
// signal while the staging directory still exists. setInterval (not a
// bare unresolved Promise) keeps this process genuinely busy, the way
// a real blocked ssh call would be — needed so the SIGINT/SIGTERM
// tests below prove deploy actually KILLS this child, not just that it
// happened to already exit on its own. Same self-deadline as above, in
// case deploy's own signal handling regresses and never reaches this
// grandchild.
const hangOn = Deno.env.get("FAKE_SSH_HANG_ON")
if (hangOn && script.includes(hangOn)) {
  // FAKE_SSH_PID_FILE: record this process's own pid before hanging, so
  // a test can prove deploy actually killed THIS process (not just
  // that deploy itself exited) by checking the pid is gone afterward.
  const pidFile = Deno.env.get("FAKE_SSH_PID_FILE")
  if (pidFile) await Deno.writeTextFile(pidFile, String(Deno.pid))
  setTimeout(() => Deno.exit(1), 20_000)
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
if (script.includes("getent group docker")) {
  const gid = Deno.env.get("FAKE_DOCKER_GID") ?? "988"
  console.log(\`docker:x:\${gid}:\`)
} else if (script === "id -u") {
  // Default: root (uid 0) — matches SSH_ADDRESS=deploy@remote.test in the
  // fixtures below, which is a placeholder address, not a real login.
  console.log(Deno.env.get("FAKE_REMOTE_UID") ?? "0")
} else if (script.includes("DEPLOY_START:")) {
  // FAKE_DEPLOY_FAIL_STACK lets a test simulate a stack whose
  // \`docker compose up\` fails on the remote — everything else about
  // the fake remote (docker group, uid) stays healthy.
  const failStack = Deno.env.get("FAKE_DEPLOY_FAIL_STACK")
  for (const m of script.matchAll(/DEPLOY_START:(\\S+):(\\S+)/g)) {
    console.log(\`DEPLOY_START:\${m[1]}:\${m[2]}\`)
    if (m[1] === failStack) {
      console.log("simulated docker compose failure")
      console.log(\`DEPLOY_FAILED:\${m[1]}:\${m[2]}\`)
    } else {
      console.log(\`DEPLOY_SUCCESS:\${m[1]}:\${m[2]}\`)
    }
  }
}
Deno.exit(0)
`

const FAKE_RSYNC = `#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
// Copies the local staging dir (second-to-last arg, "src/") into
// FAKE_REMOTE_DIR + the remote path from the last arg ("user@host:/path/"),
// standing in for the real server the deploy would rsync to.
const args = Deno.args
const dest = args[args.length - 1]
const src = args[args.length - 2].replace(/\\/$/, "")
const colonIdx = dest.indexOf(":")
const remotePath = dest.slice(colonIdx + 1)
const remoteRoot = Deno.env.get("FAKE_REMOTE_DIR")!
const destDir = remoteRoot + remotePath

async function copyDir(s: string, d: string) {
  await Deno.mkdir(d, { recursive: true })
  for await (const entry of Deno.readDir(s)) {
    const sp = \`\${s}/\${entry.name}\`
    const dp = \`\${d}/\${entry.name}\`
    if (entry.isDirectory) {
      await copyDir(sp, dp)
    } else if (entry.isFile) {
      await Deno.copyFile(sp, dp)
    }
  }
}
await copyDir(src, destDir)
Deno.exit(0)
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

  await Deno.writeTextFile(join(binDir, "ssh"), FAKE_SSH, { mode: 0o755 })
  await Deno.writeTextFile(join(binDir, "rsync"), FAKE_RSYNC, { mode: 0o755 })

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

    const result = await runDeployCli(f, ["deploy", "test"])
    if (!result.success) console.error(result.stderr)
    assertEquals(result.success, true)

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
    const log = await Deno.readTextFile(f.logPath)
    assertStringIncludes(log, "getent group docker")
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
    // that file must then reach the "remote" through rsync, the same as
    // any other file under stacks/custom-stack/. It also self-checks
    // that the stack's own hook already ran, and records its own cwd +
    // the contract env keys for the test to assert on.
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
    const result = await runDeployCli(f, ["deploy", "test"], { SERVER_HOOK_LOG: hookLog })
    if (!result.success) console.error(result.stderr)
    assertEquals(result.success, true)

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
    // reaches the "remote" via rsync, so the test can check the exact
    // bytes that survived the whole env-passing pipeline (parseEnv →
    // hooks.ts's allowlist → Deno.Command's `env` option → Deno.env.get
    // inside the hook). Deno's own `--env-file` flag mangles `$` in
    // values like bcrypt hashes; rostok never uses it for this reason
    // (see hooks.ts). The key is prefixed with the stack's own name
    // (#217's allowlist, second pass) — an unprefixed SECRET_HASH would
    // now be dropped before it ever reached the hook.
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

    const result = await runDeployCli(f, ["deploy", "test"])
    if (!result.success) console.error(result.stderr)
    assertEquals(result.success, true)

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

    const result = await runDeployCli(f, ["deploy", "test"])
    if (!result.success) console.error(result.stderr)
    assertEquals(result.success, true)

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

    const result = await runDeployCli(f, ["deploy", "test"])
    if (!result.success) console.error(result.stderr)
    assertEquals(result.success, true)

    const log = await Deno.readTextFile(f.logPath)
    // The real, merged value reached the remote mkdir/chown command...
    assertStringIncludes(log, "mkdir -p '/srv/volumes/vol-stack/data'")
    // ...never the literal, unexpanded placeholder.
    assertEquals(log.includes("${VOLUMES_PATH}"), false)
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
  // Both carry secrets, and rsync -a preserves the local staging mode on
  // the remote — a 0644 copy in PATH_APPS is readable by every user on a
  // shared box. The staging dir is private to runDeploy and gets removed
  // before the CLI subprocess exits, so this checks the mode from
  // inside, at the point Deno.removeSync is about to delete it.
  const { runDeploy } = await import("../deploy/run-deploy.ts")

  const f = await setupFixture()
  try {
    await writeServer(f.projectDir, [], [])

    const previousPath = Deno.env.get("PATH") ?? ""
    Deno.env.set("PATH", `${f.binDir}:${previousPath}`)
    Deno.env.set("FAKE_REMOTE_DIR", f.remoteDir)
    Deno.env.set("FAKE_SSH_LOG", f.logPath)

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
      await runDeploy({ cwd: f.projectDir, server: "test" })
    } finally {
      Deno.removeSync = originalRemoveSync
      Deno.env.set("PATH", previousPath)
      Deno.env.delete("FAKE_REMOTE_DIR")
      Deno.env.delete("FAKE_SSH_LOG")
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
  // observe a failure there without reaching into its private temp dir,
  // call runDeploy in-process (not the CLI subprocess) and make
  // Deno.remove throw for the duration of this one test.
  const { runDeploy } = await import("../deploy/run-deploy.ts")

  const f = await setupFixture()
  try {
    await writeServer(f.projectDir, [], [])

    const previousPath = Deno.env.get("PATH") ?? ""
    Deno.env.set("PATH", `${f.binDir}:${previousPath}`)
    Deno.env.set("FAKE_REMOTE_DIR", f.remoteDir)
    Deno.env.set("FAKE_SSH_LOG", f.logPath)

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
      await runDeploy({ cwd: f.projectDir, server: "test" })
    } finally {
      Deno.removeSync = originalRemoveSync
      console.error = originalConsoleError
      Deno.env.set("PATH", previousPath)
      Deno.env.delete("FAKE_REMOTE_DIR")
      Deno.env.delete("FAKE_SSH_LOG")
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

    const result = await runDeployCli(f, ["deploy", "test"], {
      FAKE_DEPLOY_FAIL_STACK: "librespeed",
    })
    assertEquals(result.success, false)
    assertEquals(result.code, 1)
    // Names the stack...
    assertStringIncludes(result.stderr, "librespeed")
    // ...and the step (docker compose up / deploy), not a bare stack trace.
    assertStringIncludes(result.stderr, "failed to deploy")
    assertCleanFailure(result.stderr)
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
 * Spawn `rostok deploy test` with FAKE_SSH_HANG_ON set (holds the fake
 * ssh call busy — see FAKE_SSH above — after the staging dir is
 * created and populated by rsync but before deploy finishes). Waits
 * for the fake ssh's own log to actually show the blocking command
 * (`docker network inspect proxy`) — not just for the staging dir to
 * exist, which can appear well before that ssh call starts — before
 * sending `signal`. Returns the exit code, whether the staging dir
 * survived, and whether the fake ssh's own pid (written to a file
 * right before it hangs) is still alive afterward — the real proof
 * that deploy KILLED it, not just that deploy itself exited.
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
        // Hold the deploy open after rsync (staging dir already
        // created and populated) but before it finishes.
        FAKE_SSH_HANG_ON: "docker network inspect proxy",
        FAKE_SSH_PID_FILE: pidFile,
        TMPDIR: tmpRoot,
      },
      stdout: "piped",
      stderr: "piped",
    })
    const child = command.spawn()

    await waitForFileToInclude(f.logPath, "docker network inspect proxy")
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
  // window entirely.
  const f = await setupFixture()
  const tmpRoot = await Deno.makeTempDir({ prefix: "rostok-e2e-tmproot-" })
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
        TMPDIR: tmpRoot,
      },
      stdout: "piped",
      stderr: "piped",
    })
    const child = command.spawn()

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
    assertEquals(output.code, 130)

    await assertNotExists(stagingDirPath)
  } finally {
    await Deno.remove(tmpRoot, { recursive: true }).catch(() => {})
    await teardownFixture(f)
  }
})

Deno.test("e2e: runDeploy removes its signal listeners after finishing normally (#219)", async () => {
  // Seam: spy on Deno.addSignalListener/removeSignalListener around one
  // successful in-process run-deploy call. A listener registered but
  // never removed would leave this process still reacting to SIGINT
  // after the function returned.
  const { runDeploy } = await import("../deploy/run-deploy.ts")

  const f = await setupFixture()
  try {
    await writeServer(f.projectDir, [], [])

    const previousPath = Deno.env.get("PATH") ?? ""
    Deno.env.set("PATH", `${f.binDir}:${previousPath}`)
    Deno.env.set("FAKE_REMOTE_DIR", f.remoteDir)
    Deno.env.set("FAKE_SSH_LOG", f.logPath)
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
      await runDeploy({ cwd: f.projectDir, server: "test" })
    } finally {
      Deno.addSignalListener = originalAdd
      Deno.removeSignalListener = originalRemove
      Deno.env.set("PATH", previousPath)
      Deno.env.delete("FAKE_REMOTE_DIR")
      Deno.env.delete("FAKE_SSH_LOG")
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
