// Tests for stacks/open-webui/after.deploy.ts's pure ssh argv helpers.
// (No shell interaction — that runs via the deploy script.)

import { assertEquals } from "@std/assert"
import { buildSshOptionArgs, targetHost } from "./after.deploy.ts"

Deno.test("buildSshOptionArgs: -p then the standard options", () => {
  assertEquals(buildSshOptionArgs("22"), [
    "-p",
    "22",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
  ])
})

Deno.test("buildSshOptionArgs: carries the port from SSH_ADDRESS's :2222 form (#229's reported bug)", () => {
  // Before this fix, every ssh call in this hook used the raw
  // SSH_ADDRESS string directly, so a "host:port" SSH_ADDRESS reached
  // ssh as one unresolvable hostname. SSH_HOST/SSH_PORT are already
  // split apart before this hook ever sees them.
  assertEquals(buildSshOptionArgs("2222"), [
    "-p",
    "2222",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
  ])
})

Deno.test("targetHost: user@host when a user is set", () => {
  assertEquals(targetHost("192.0.2.10", "root"), "root@192.0.2.10")
})

Deno.test("targetHost: bare host with no user", () => {
  assertEquals(targetHost("homelab", undefined), "homelab")
})

/**
 * Install a fake `ssh` on PATH that appends its own argv (one per line,
 * plus a blank separator line) to `logPath`, then exits 1.
 */
async function withFakeSsh<T>(fn: (logPath: string) => Promise<T>): Promise<T> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-ssh-open-webui-" })
  const logPath = `${binDir}/argv.log`
  try {
    const script =
      `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${logPath}"; done\nprintf '\\n' >> "${logPath}"\nexit 1\n`
    await Deno.writeTextFile(`${binDir}/ssh`, script, { mode: 0o755 })
    const previousPath = Deno.env.get("PATH") ?? ""
    Deno.env.set("PATH", `${binDir}:${previousPath}`)
    try {
      return await fn(logPath)
    } finally {
      Deno.env.set("PATH", previousPath)
    }
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
}

Deno.test("after.deploy.ts subprocess: SSH_ADDRESS=root@192.0.2.1:2222 reaches ssh's first call as -p 2222 (fake ssh)", async () => {
  await withFakeSsh(async (logPath) => {
    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", import.meta.resolve("./after.deploy.ts")],
      env: {
        ...Deno.env.toObject(),
        // What deploy sets today, parsed once from SSH_ADDRESS=root@192.0.2.1:2222
        // by cli/deploy/hooks.ts's buildHookEnv — this hook never sees
        // SSH_ADDRESS itself any more.
        SSH_HOST: "192.0.2.1",
        SSH_PORT: "2222",
        SSH_USER: "root",
        PATH_APPS: "/srv/apps",
        OPEN_WEBUI_OPENAI_API_KEYS: "sk-test",
        OPEN_WEBUI_OPENAI_API_BASE_URLS: "https://example.com/v1",
      },
      stdout: "null",
      stderr: "null",
    })
    await command.output()
    // This test only checks what reached ssh's argv for the first call
    // (docker cp), not the rest of the hook's business logic — the fake
    // exits 1, so the hook fails right after (expected).
    const logged = await Deno.readTextFile(logPath)
    const lines = logged.split("\n")
    assertEquals(lines.slice(0, 8), [
      "-p",
      "2222",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      "--",
      "root@192.0.2.1",
    ])
  })
})
