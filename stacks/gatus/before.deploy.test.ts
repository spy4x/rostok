// Tests for stacks/gatus/before.deploy.ts: the hook as a subprocess in a deploy staging folder,
// against a local server folder or a fake `ssh` on PATH (#397).

import { assertEquals, assertNotEquals } from "@std/assert"
import { join } from "@std/path"
import { parseReadOutput } from "./before.deploy.ts"

const SHIPPED = new URL("./config.yml", import.meta.url)

Deno.test("parseReadOutput: the first line is the mtime, the rest the content", () => {
  assertEquals(parseReadOutput("1700000000.5\nendpoints: []\n"), {
    mtime: 1700000000.5,
    content: "endpoints: []\n",
  })
  assertEquals(parseReadOutput("\nendpoints: []\n"), {
    mtime: undefined,
    content: "endpoints: []\n",
  })
})

/**
 * Runs the hook in a fresh staging folder holding the shipped config.yml, plus configs/gatus.yml
 * when `override` is given, and returns the staged config.yml's content and mtime in ms. `binDir`
 * goes first on PATH when given.
 */
async function runInStaging(
  env: Record<string, string>,
  override?: string,
  binDir?: string,
): Promise<{ content: string; mtime: number }> {
  const staging = await Deno.makeTempDir()
  try {
    await Deno.mkdir(join(staging, "stacks/gatus"), { recursive: true })
    await Deno.copyFile(SHIPPED, join(staging, "stacks/gatus/config.yml"))
    if (override !== undefined) {
      await Deno.mkdir(join(staging, "configs"))
      await Deno.writeTextFile(join(staging, "configs/gatus.yml"), override)
    }
    const parent = Deno.env.toObject()
    for (const key of ["SSH_HOST", "SSH_PORT", "SSH_USER", "PATH_APPS", "FAKE_SSH_DEPTH"]) {
      delete parent[key]
    }
    const path = binDir ? `${binDir}:${parent.PATH ?? ""}` : parent.PATH ?? ""
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", new URL("./before.deploy.ts", import.meta.url).href],
      cwd: staging,
      env: { ...parent, ...env, PATH: path },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr))
    const file = join(staging, "stacks/gatus/config.yml")
    return {
      content: await Deno.readTextFile(file),
      mtime: (await Deno.stat(file)).mtime!.getTime(),
    }
  } finally {
    await Deno.remove(staging, { recursive: true })
  }
}

/** A local server's PATH_APPS whose stacks/gatus/config.yml holds `content`, mtime in 2020. */
async function makeServer(content: string): Promise<{ pathApps: string; mtime: number }> {
  const pathApps = await Deno.makeTempDir()
  await Deno.mkdir(join(pathApps, "stacks/gatus"), { recursive: true })
  const file = join(pathApps, "stacks/gatus/config.yml")
  await Deno.writeTextFile(file, content)
  const mtime = new Date("2020-01-02T03:04:05.678Z")
  await Deno.utime(file, mtime, mtime)
  return { pathApps, mtime: mtime.getTime() }
}

Deno.test("an unchanged server config.yml is staged with the server's mtime", async () => {
  const server = await makeServer("endpoints: [a]\n")
  try {
    const staged = await runInStaging({ PATH_APPS: server.pathApps }, "endpoints: [a]\n")
    assertEquals(staged, { content: "endpoints: [a]\n", mtime: server.mtime })
  } finally {
    await Deno.remove(server.pathApps, { recursive: true })
  }
})

Deno.test("an unchanged shipped config.yml is staged with the server's mtime", async () => {
  const shipped = await Deno.readTextFile(SHIPPED)
  const server = await makeServer(shipped)
  try {
    const staged = await runInStaging({ PATH_APPS: server.pathApps })
    assertEquals(staged, { content: shipped, mtime: server.mtime })
  } finally {
    await Deno.remove(server.pathApps, { recursive: true })
  }
})

Deno.test("a changed config.yml keeps its new content and mtime", async () => {
  const server = await makeServer("endpoints: [old]\n")
  try {
    const staged = await runInStaging({ PATH_APPS: server.pathApps }, "endpoints: [new]\n")
    assertEquals(staged.content, "endpoints: [new]\n")
    assertNotEquals(staged.mtime, server.mtime)
  } finally {
    await Deno.remove(server.pathApps, { recursive: true })
  }
})

Deno.test("a server without config.yml leaves the staged file as copied", async () => {
  const pathApps = await Deno.makeTempDir()
  try {
    const staged = await runInStaging({ PATH_APPS: pathApps }, "endpoints: [a]\n")
    assertEquals(staged.content, "endpoints: [a]\n")
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("over ssh, an unchanged config.yml is staged with the server's mtime", async () => {
  const binDir = await Deno.makeTempDir()
  try {
    // The fake ssh answers like the server: the mtime line, then the file. It calls no program
    // named ssh, and its depth guard makes it exit 97 if it is ever entered from itself.
    await Deno.writeTextFile(join(binDir, "server-file"), "endpoints: [a]\n")
    await Deno.writeTextFile(
      join(binDir, "ssh"),
      `#!/bin/sh\n[ -n "$FAKE_SSH_DEPTH" ] && exit 97\nexport FAKE_SSH_DEPTH=1\n` +
        `echo 1577934245.678\ncat "${join(binDir, "server-file")}"\n`,
      { mode: 0o755 },
    )
    const env = { PATH_APPS: "/srv/apps", SSH_HOST: "192.0.2.10", SSH_USER: "user" }
    const staged = await runInStaging(env, "endpoints: [a]\n", binDir)
    assertEquals(staged, { content: "endpoints: [a]\n", mtime: 1577934245678 })
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
})
