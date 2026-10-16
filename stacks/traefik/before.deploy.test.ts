// Tests for stacks/traefik/before.deploy.ts: its pure helpers, and the copy of a server's own
// dynamic config files, by function and by running the hook in a staging folder.

import { assertEquals, assertNotEquals, assertRejects, assertThrows } from "@std/assert"
import { join } from "@std/path"
import { compareSync, getRounds } from "npm:bcryptjs@3.0.3"

import {
  copyServerConfigs,
  hashPassword,
  parseReadOutput,
  resolveHtpasswdCredential,
} from "./before.deploy.ts"

/** Build a `getEnv` from a plain object, as resolveHtpasswdCredential expects. */
function envFrom(vars: Record<string, string>): (key: string) => string | undefined {
  return (key) => vars[key]
}

Deno.test("hashPassword: bcryptjs.compareSync accepts the original password", () => {
  const hash = hashPassword("correct horse battery staple")
  assertEquals(compareSync("correct horse battery staple", hash), true)
})

Deno.test("hashPassword: bcryptjs.compareSync rejects a wrong password", () => {
  const hash = hashPassword("correct horse battery staple")
  assertEquals(compareSync("wrong password", hash), false)
})

Deno.test("hashPassword: output is a bcrypt hash Traefik's basicAuth accepts", () => {
  const hash = hashPassword("x")
  // $2a$/$2b$/$2y$ + 2-digit cost + "$" + 53-char salt+digest.
  assertEquals(/^\$2[aby]\$\d{2}\$.{53}$/.test(hash), true)
})

Deno.test("hashPassword: cost is pinned at 10", () => {
  // The format check above accepts any 2-digit cost, so a lowered cost
  // (weaker hashing, faster to brute-force) wouldn't fail it. Read the
  // actual cost back out with bcryptjs's own getRounds() instead of
  // matching the hash string, so this doesn't depend on which of
  // $2a/$2b/$2y hashSync happens to emit.
  const hash = hashPassword("x")
  assertEquals(getRounds(hash), 10)
})

Deno.test("hashPassword: two calls for the same password produce different hashes", () => {
  // bcrypt salts each hash — a fixed hash for a fixed password would let
  // an attacker precompute the dashboard credential from the repo.
  const a = hashPassword("same password")
  const b = hashPassword("same password")
  assertNotEquals(a, b)
  assertEquals(compareSync("same password", a), true)
  assertEquals(compareSync("same password", b), true)
})

// ── resolveHtpasswdCredential ───────────────────────────────────────────

Deno.test("resolveHtpasswdCredential: new keys both set — hashes the password", () => {
  const cred = resolveHtpasswdCredential(envFrom({
    TRAEFIK_BASIC_AUTH_USER: "admin",
    TRAEFIK_BASIC_AUTH_PASSWORD: "s3cr3t",
  }))
  assertEquals(cred.user, "admin")
  assertEquals(compareSync("s3cr3t", cred.hash), true)
})

Deno.test("resolveHtpasswdCredential: user set, password missing — names PASSWORD, not USER", () => {
  assertThrows(
    () => resolveHtpasswdCredential(envFrom({ TRAEFIK_BASIC_AUTH_USER: "admin" })),
    Error,
    "TRAEFIK_BASIC_AUTH_PASSWORD is not",
  )
})

Deno.test("resolveHtpasswdCredential: password set, user missing — names USER, not PASSWORD", () => {
  assertThrows(
    () => resolveHtpasswdCredential(envFrom({ TRAEFIK_BASIC_AUTH_PASSWORD: "s3cr3t" })),
    Error,
    "TRAEFIK_BASIC_AUTH_USER is not",
  )
})

Deno.test("resolveHtpasswdCredential: nothing set — throws instead of silently skipping", () => {
  assertThrows(
    () => resolveHtpasswdCredential(envFrom({})),
    Error,
    "No basic-auth credentials set",
  )
})

Deno.test("resolveHtpasswdCredential: legacy BASIC_AUTH_USER/PASSWORD is not read — throws", () => {
  // The pre-#210 legacy branch (BASIC_AUTH_USER + BASIC_AUTH_BASE64 /
  // an already-hashed BASIC_AUTH_PASSWORD) is gone. Setting only the
  // legacy keys must throw the same "nothing set" error as setting
  // nothing at all — not silently succeed with a stale credential.
  assertThrows(
    () =>
      resolveHtpasswdCredential(envFrom({
        BASIC_AUTH_USER: "legacyadmin",
        BASIC_AUTH_PASSWORD: "plaintextpass",
      })),
    Error,
    "No basic-auth credentials set",
  )
})

// ── copyServerConfigs ───────────────────────────────────────────────────

Deno.test("a server's own dynamic config files are copied next to the catalog's base file", async () => {
  const root = await Deno.makeTempDir()
  try {
    const source = join(root, "configs")
    const dest = join(root, "dynamic")
    await Deno.mkdir(source)
    await Deno.mkdir(dest)
    await Deno.writeTextFile(join(dest, "00-base.yml"), "base\n")
    await Deno.writeTextFile(join(source, "10-cors.yml"), "cors\n")
    await Deno.writeTextFile(join(source, "20-routes.yaml"), "routes\n")

    assertEquals(await copyServerConfigs(source, dest), ["10-cors.yml", "20-routes.yaml"])
    assertEquals(await Deno.readTextFile(join(dest, "10-cors.yml")), "cors\n")
    assertEquals(await Deno.readTextFile(join(dest, "20-routes.yaml")), "routes\n")
    assertEquals(await Deno.readTextFile(join(dest, "00-base.yml")), "base\n")
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("only plain .yml and .yaml files are copied: no notes, folders or symlinks", async () => {
  const root = await Deno.makeTempDir()
  try {
    const source = join(root, "configs")
    const dest = join(root, "dynamic")
    await Deno.mkdir(join(source, "old.yml"), { recursive: true })
    await Deno.mkdir(dest)
    await Deno.writeTextFile(join(root, "outside.yml"), "outside\n")
    await Deno.writeTextFile(join(source, "notes.md"), "notes\n")
    await Deno.writeTextFile(join(source, "10-a.yml"), "a\n")
    await Deno.symlink(join(root, "outside.yml"), join(source, "20-link.yml"))

    assertEquals(await copyServerConfigs(source, dest), ["10-a.yml"])
    assertEquals((await Array.fromAsync(Deno.readDir(dest))).map((e) => e.name), ["10-a.yml"])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("a server without configs/traefik/dynamic deploys the catalog's files only", async () => {
  const root = await Deno.makeTempDir()
  try {
    assertEquals(await copyServerConfigs(join(root, "missing"), root), [])
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("a missing destination fails the deploy instead of dropping the server's files", async () => {
  const root = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(join(root, "10-a.yml"), "a\n")
    await assertRejects(() => copyServerConfigs(root, join(root, "missing")), Deno.errors.NotFound)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("the hook adds a server's configs/traefik/dynamic files in a deploy staging folder", async () => {
  const staging = await Deno.makeTempDir()
  try {
    const dynamic = join(staging, "stacks/traefik/dynamic")
    await Deno.mkdir(dynamic, { recursive: true })
    await Deno.copyFile(
      new URL("./dynamic/00-base.yml", import.meta.url),
      join(dynamic, "00-base.yml"),
    )
    await Deno.mkdir(join(staging, "configs/traefik/dynamic"), { recursive: true })
    await Deno.writeTextFile(join(staging, "configs/traefik/dynamic/10-cors.yml"), "server\n")

    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", new URL("./before.deploy.ts", import.meta.url).href],
      cwd: staging,
      env: { TRAEFIK_BASIC_AUTH_USER: "admin", TRAEFIK_BASIC_AUTH_PASSWORD: "s3cr3t" },
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr))

    assertEquals(await Deno.readTextFile(join(dynamic, "10-cors.yml")), "server\n")
    assertEquals(
      await Deno.readTextFile(join(dynamic, "00-base.yml")),
      await Deno.readTextFile(new URL("./dynamic/00-base.yml", import.meta.url)),
    )
    const [user, hash] = (await Deno.readTextFile(join(dynamic, ".htpasswd"))).trim().split(":")
    assertEquals(user, "admin")
    assertEquals(compareSync("s3cr3t", hash), true)
  } finally {
    await Deno.remove(staging, { recursive: true })
  }
})

// ── keeping an unchanged .htpasswd (#397) ───────────────────────────────

const creds = (user: string, password: string) => (key: string) =>
  ({ TRAEFIK_BASIC_AUTH_USER: user, TRAEFIK_BASIC_AUTH_PASSWORD: password })[key]

Deno.test("resolveHtpasswdCredential: keeps the server's hash when the password still matches", () => {
  const hash = hashPassword("s3cr3t")
  const credential = resolveHtpasswdCredential(creds("admin", "s3cr3t"), `admin:${hash}\n`)
  assertEquals(credential, { user: "admin", hash })
})

Deno.test("resolveHtpasswdCredential: a changed password gets a new hash", () => {
  const old = hashPassword("old-pass")
  const credential = resolveHtpasswdCredential(creds("admin", "new-pass"), `admin:${old}\n`)
  assertNotEquals(credential.hash, old)
  assertEquals(compareSync("new-pass", credential.hash), true)
})

Deno.test("resolveHtpasswdCredential: a changed user gets a new hash", () => {
  const old = hashPassword("s3cr3t")
  const credential = resolveHtpasswdCredential(creds("root", "s3cr3t"), `admin:${old}\n`)
  assertEquals(credential.user, "root")
  assertNotEquals(credential.hash, old)
})

Deno.test("resolveHtpasswdCredential: a file with more than the one line is replaced", () => {
  const old = hashPassword("s3cr3t")
  const existing = `admin:${old}\nother:${old}\n`
  const credential = resolveHtpasswdCredential(creds("admin", "s3cr3t"), existing)
  assertNotEquals(credential.hash, old)
})

Deno.test("parseReadOutput: the first line is the mtime, the rest the content", () => {
  assertEquals(parseReadOutput("1700000000.123456789\nadmin:x\n"), {
    mtime: 1700000000.123456789,
    content: "admin:x\n",
  })
  assertEquals(parseReadOutput("\nadmin:x\n"), { mtime: undefined, content: "admin:x\n" })
})

/**
 * Runs the hook in a fresh staging folder with the catalog's 00-base.yml and returns the staged
 * .htpasswd's content and mtime. `binDir` goes first on PATH when given.
 */
async function runInStaging(
  env: Record<string, string>,
  binDir?: string,
): Promise<{ content: string; mtime: number }> {
  const staging = await Deno.makeTempDir()
  try {
    const dynamic = join(staging, "stacks/traefik/dynamic")
    await Deno.mkdir(dynamic, { recursive: true })
    await Deno.copyFile(
      new URL("./dynamic/00-base.yml", import.meta.url),
      join(dynamic, "00-base.yml"),
    )
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
    const file = join(dynamic, ".htpasswd")
    return {
      content: await Deno.readTextFile(file),
      mtime: (await Deno.stat(file)).mtime!.getTime(),
    }
  } finally {
    await Deno.remove(staging, { recursive: true })
  }
}

/** A local server's PATH_APPS whose .htpasswd holds `content` with an mtime in 2020. */
async function makeServer(content: string): Promise<{ pathApps: string; mtime: number }> {
  const pathApps = await Deno.makeTempDir()
  await Deno.mkdir(join(pathApps, "stacks/traefik/dynamic"), { recursive: true })
  const file = join(pathApps, "stacks/traefik/dynamic/.htpasswd")
  await Deno.writeTextFile(file, content)
  const mtime = new Date("2020-01-02T03:04:05.678Z")
  await Deno.utime(file, mtime, mtime)
  return { pathApps, mtime: mtime.getTime() }
}

Deno.test("an unchanged password stages the server's .htpasswd byte for byte, with its mtime", async () => {
  const existing = `admin:${hashPassword("s3cr3t")}\n`
  const server = await makeServer(existing)
  try {
    const staged = await runInStaging({
      TRAEFIK_BASIC_AUTH_USER: "admin",
      TRAEFIK_BASIC_AUTH_PASSWORD: "s3cr3t",
      PATH_APPS: server.pathApps,
    })
    assertEquals(staged, { content: existing, mtime: server.mtime })
  } finally {
    await Deno.remove(server.pathApps, { recursive: true })
  }
})

Deno.test("a changed password stages a new .htpasswd with a new mtime", async () => {
  const existing = `admin:${hashPassword("old-pass")}\n`
  const server = await makeServer(existing)
  try {
    const staged = await runInStaging({
      TRAEFIK_BASIC_AUTH_USER: "admin",
      TRAEFIK_BASIC_AUTH_PASSWORD: "new-pass",
      PATH_APPS: server.pathApps,
    })
    assertNotEquals(staged.content, existing)
    assertNotEquals(staged.mtime, server.mtime)
    assertEquals(compareSync("new-pass", staged.content.trim().split(":")[1]), true)
  } finally {
    await Deno.remove(server.pathApps, { recursive: true })
  }
})

Deno.test("a server without .htpasswd gets a fresh one", async () => {
  const pathApps = await Deno.makeTempDir()
  try {
    const staged = await runInStaging({
      TRAEFIK_BASIC_AUTH_USER: "admin",
      TRAEFIK_BASIC_AUTH_PASSWORD: "s3cr3t",
      PATH_APPS: pathApps,
    })
    assertEquals(compareSync("s3cr3t", staged.content.trim().split(":")[1]), true)
  } finally {
    await Deno.remove(pathApps, { recursive: true })
  }
})

Deno.test("over ssh, an unchanged password keeps the server's .htpasswd and its mtime", async () => {
  const existing = `admin:${hashPassword("s3cr3t")}\n`
  const binDir = await Deno.makeTempDir()
  try {
    // The fake ssh answers like the server: the mtime line, then the file. It calls no program
    // named ssh, and its depth guard makes it exit 97 if it is ever entered from itself.
    await Deno.writeTextFile(join(binDir, "server-file"), existing)
    await Deno.writeTextFile(
      join(binDir, "ssh"),
      `#!/bin/sh\n[ -n "$FAKE_SSH_DEPTH" ] && exit 97\nexport FAKE_SSH_DEPTH=1\n` +
        `echo 1577934245.678\ncat "${join(binDir, "server-file")}"\n`,
      { mode: 0o755 },
    )
    const staged = await runInStaging({
      TRAEFIK_BASIC_AUTH_USER: "admin",
      TRAEFIK_BASIC_AUTH_PASSWORD: "s3cr3t",
      PATH_APPS: "/srv/apps",
      SSH_HOST: "192.0.2.10",
      SSH_USER: "user",
    }, binDir)
    assertEquals(staged, { content: existing, mtime: 1577934245678 })
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
})

Deno.test("over ssh, a failed read writes a fresh .htpasswd", async () => {
  const binDir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(join(binDir, "ssh"), `#!/bin/sh\nexit 255\n`, { mode: 0o755 })
    const staged = await runInStaging({
      TRAEFIK_BASIC_AUTH_USER: "admin",
      TRAEFIK_BASIC_AUTH_PASSWORD: "s3cr3t",
      PATH_APPS: "/srv/apps",
      SSH_HOST: "192.0.2.10",
    }, binDir)
    assertEquals(compareSync("s3cr3t", staged.content.trim().split(":")[1]), true)
  } finally {
    await Deno.remove(binDir, { recursive: true })
  }
})
