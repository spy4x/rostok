// Tests for stacks/caldiy/after.deploy.ts's pure ssh argv builder.
// (No shell interaction beyond the fake ssh below.)

import { assertEquals, assertThrows } from "@std/assert"
import { buildSshArgs } from "./after.deploy.ts"

Deno.test("buildSshArgs: -p, the standard options, then '--' then the target and command", () => {
  const args = buildSshArgs("192.0.2.10", "22", "root", "docker exec -i hl-caldiy-db psql")
  assertEquals(args, [
    "-p",
    "22",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "--",
    "root@192.0.2.10",
    "docker exec -i hl-caldiy-db psql",
  ])
})

Deno.test("buildSshArgs: carries a non-default port (#229 — root cause: SSH_ADDRESS with :2222)", () => {
  const args = buildSshArgs("192.0.2.10", "2222", "root", "docker exec -i hl-caldiy-db psql")
  assertEquals(args[0], "-p")
  assertEquals(args[1], "2222")
})

Deno.test("buildSshArgs: no user — bare host as the target", () => {
  const args = buildSshArgs("homelab", "22", undefined, "id")
  assertEquals(args, [
    "-p",
    "22",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "--",
    "homelab",
    "id",
  ])
})

Deno.test("buildSshArgs: no SSH_PORT — omits -p entirely (an ssh_config alias's own Port wins)", () => {
  const args = buildSshArgs("homelab", undefined, undefined, "id")
  assertEquals(args, ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "--", "homelab", "id"])
})

Deno.test("buildSshArgs: rejects a non-numeric SSH_PORT", () => {
  assertThrows(() => buildSshArgs("homelab", "abc", undefined, "id"), Error, "invalid SSH_PORT")
})

Deno.test("buildSshArgs: rejects a port outside 1-65535", () => {
  assertThrows(() => buildSshArgs("homelab", "0", undefined, "id"), Error, "invalid SSH_PORT")
  assertThrows(() => buildSshArgs("homelab", "65536", undefined, "id"), Error, "invalid SSH_PORT")
})

/**
 * Install a fake `ssh` on PATH that appends its own argv (one per line,
 * plus a blank separator line) to `logPath`, then exits 1 — the hook's
 * own stdout/stderr pipes stay reserved for its own I/O (psql() pipes
 * the fake's stdout internally, so a real caller never sees anything
 * printed there), so the fake writes to a separate file instead.
 */
async function withFakeSsh<T>(fn: (logPath: string) => Promise<T>): Promise<T> {
  const binDir = await Deno.makeTempDir({ prefix: "rostok-fake-ssh-caldiy-" })
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

Deno.test("after.deploy.ts subprocess: SSH_ADDRESS=root@192.0.2.1:2222 reaches ssh as -p 2222 (fake ssh)", async () => {
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
      },
      stdout: "null",
      stderr: "null",
    })
    await command.output()
    // This test only checks what reached ssh's argv, not the rest of the
    // hook's business logic — the fake exits 1, so the hook fails right
    // after (expected).
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

Deno.test("after.deploy.ts subprocess: no SSH_PORT — omits -p entirely (fake ssh)", async () => {
  await withFakeSsh(async (logPath) => {
    const env = { ...Deno.env.toObject() }
    delete env.SSH_PORT
    const command = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", import.meta.resolve("./after.deploy.ts")],
      env: {
        ...env,
        SSH_HOST: "192.0.2.1",
        SSH_USER: "root",
        PATH_APPS: "/srv/apps",
      },
      stdout: "null",
      stderr: "null",
    })
    await command.output()
    const logged = await Deno.readTextFile(logPath)
    const lines = logged.split("\n")
    assertEquals(lines.slice(0, 6), [
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      "--",
      "root@192.0.2.1",
    ])
  })
})
