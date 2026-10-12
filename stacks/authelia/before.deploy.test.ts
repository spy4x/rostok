// Tests for stacks/authelia/before.deploy.ts: the two files it writes into a deploy staging
// folder, what they may and may not hold, when the server's own files are left alone, and how
// the SMTP password gets into the staged compose.yml.

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"
import { interpolate } from "../compose-interpolate.ts"
import { CONFIG_HASH_LABEL, CONFIG_HASH_MARKER, SMTP_PASSWORD_MARKER } from "./before.deploy.ts"
import { pbkdf2Sync } from "node:crypto"
import { Buffer } from "node:buffer"

const STACK_DIR = new URL("./", import.meta.url)
const HOOK_URL = new URL("before.deploy.ts", STACK_DIR).href

const SESSION_SECRET = "session-secret-0123456789abcdefghijklmnop"
const STORAGE_KEY = "storage-key-0123456789abcdefghijklmnopqrs"
const JWT_SECRET = "jwt-secret-0123456789abcdefghijklmnopqrstu"
const ADMIN_PASSWORD = "first-user-password-0123456789"
const SMTP_PASSWORD = "smtp-password-0123456789"

/** A server `.env` as the hook receives it: values as written, `${DOMAIN}` not filled in. */
const ENV: Record<string, string> = {
  DOMAIN: "example.test",
  AUTHELIA_DOMAIN: "auth.${DOMAIN}",
  AUTHELIA_SESSION_SECRET: SESSION_SECRET,
  AUTHELIA_STORAGE_ENCRYPTION_KEY: STORAGE_KEY,
  AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET: JWT_SECRET,
  AUTHELIA_ADMIN_USER: "admin",
  AUTHELIA_ADMIN_EMAIL: "admin@${DOMAIN}",
  AUTHELIA_ADMIN_PASSWORD: ADMIN_PASSWORD,
}

const SMTP_ENV: Record<string, string> = {
  AUTHELIA_SMTP_ADDRESS: "submission://smtp.example.test:587",
  AUTHELIA_SMTP_SENDER: "Authelia <auth@example.test>",
  AUTHELIA_SMTP_USERNAME: "auth@example.test",
  AUTHELIA_SMTP_PASSWORD: SMTP_PASSWORD,
}

interface HookRun {
  code: number
  stdout: string
  stderr: string
}

/**
 * Run the hook in `staging` with exactly `env`, like `rostok deploy` does: from its source
 * (`source`, by default the file in this folder), with the staging folder as working directory.
 */
async function runHook(
  staging: string,
  env: Record<string, string> = ENV,
  source = HOOK_URL,
): Promise<HookRun> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", source],
    cwd: staging,
    clearEnv: true,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output()
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
  return { code: out.code, stdout: text(out.stdout), stderr: text(out.stderr) }
}

/** The files a staging folder holds before the hook runs. */
const STAGED_BEFORE = ["stacks/authelia/compose.yml"]

/** Both generated files beside what was staged before. */
const STAGED_AFTER = [
  "configs/authelia/configuration.yml",
  "configs/authelia/users.yml",
  ...STAGED_BEFORE,
]

/** Run `body` with a fresh staging folder that holds the stack's compose.yml, removed afterwards. */
async function withStaging(body: (staging: string) => Promise<void>): Promise<void> {
  const staging = await Deno.makeTempDir({ prefix: "rostok-authelia-hook-" })
  try {
    await Deno.mkdir(join(staging, "stacks", "authelia"), { recursive: true })
    await Deno.copyFile(
      new URL("compose.yml", STACK_DIR),
      join(staging, "stacks", "authelia", "compose.yml"),
    )
    await body(staging)
  } finally {
    await Deno.remove(staging, { recursive: true })
  }
}

/** Every file under `dir`, relative, sorted. */
async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  const found: string[] = []
  for await (const entry of Deno.readDir(dir)) {
    const rel = prefix + entry.name
    if (entry.isDirectory) found.push(...await filesUnder(join(dir, entry.name), `${rel}/`))
    else found.push(rel)
  }
  return found.sort()
}

const configurationIn = (staging: string) =>
  Deno.readTextFile(join(staging, "configs", "authelia", "configuration.yml"))
const usersIn = (staging: string) =>
  Deno.readTextFile(join(staging, "configs", "authelia", "users.yml"))
const composeIn = (staging: string) =>
  Deno.readTextFile(join(staging, "stacks", "authelia", "compose.yml"))

/** The `KEY=value` environment items of a staged compose.yml as the server renders it. */
function environmentOf(compose: string, env: Record<string, string>): string[] {
  const code = compose.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n")
  return [...interpolate(code, env).matchAll(/^ {6}- ([A-Z_]+=.*)$/gm)].map((m) => m[1])
}

/** The hash in the config-hash label of a staged compose.yml. Throws when the label is missing. */
function configHashOf(compose: string): string {
  const found = compose.match(new RegExp(`^ +- "${CONFIG_HASH_LABEL}=([0-9a-f]{64})"$`, "m"))
  if (!found) throw new Error("compose.yml holds no config-hash label")
  return found[1]
}

/** Put the server's own `name` into staging, as deploy does before any hook runs. */
async function writeOwn(staging: string, name: string, text: string): Promise<void> {
  await Deno.mkdir(join(staging, "configs", "authelia"), { recursive: true })
  await Deno.writeTextFile(join(staging, "configs", "authelia", name), text)
}

Deno.test("the hook writes both files into staging and nothing next to its source", async () => {
  const sourceBefore = await filesUnder(STACK_DIR.pathname)
  await withStaging(async (staging) => {
    const out = await runHook(staging)
    assertEquals(out.code, 0, out.stderr)
    assertEquals(await filesUnder(staging), STAGED_AFTER)
    const configuration = await configurationIn(staging)
    assertStringIncludes(configuration, `    - domain: "example.test"\n`)
    assertStringIncludes(configuration, `      authelia_url: "https://auth.example.test"\n`)
    assertStringIncludes(await usersIn(staging), `users:\n  "admin":\n`)
    assertStringIncludes(await usersIn(staging), `    email: "admin@example.test"\n`)
  })
  assertEquals(await filesUnder(STACK_DIR.pathname), sourceBefore)
})

Deno.test("the hook works when its source is a URL that is not a local path", async () => {
  // A JSR install runs the hook from an https:// URL. A data: URL is the same case without the
  // network: the module has no folder of its own to read or write.
  const code = await Deno.readTextFile(new URL(HOOK_URL))
  const source = `data:application/typescript;base64,${Buffer.from(code).toString("base64")}`
  await withStaging(async (staging) => {
    const out = await runHook(staging, ENV, source)
    assertEquals(out.code, 0, out.stderr)
    assertEquals(await filesUnder(staging), STAGED_AFTER)
  })
})

Deno.test("the server's own configuration.yml is kept, and users.yml is still generated", async () => {
  await withStaging(async (staging) => {
    await writeOwn(staging, "configuration.yml", "# the server's own\n")
    const out = await runHook(staging)
    assertEquals(out.code, 0, out.stderr)
    assertEquals(await configurationIn(staging), "# the server's own\n")
    assertStringIncludes(await usersIn(staging), `users:\n  "admin":\n`)
  })
})

Deno.test("the server's own users.yml is kept, and configuration.yml is still generated", async () => {
  await withStaging(async (staging) => {
    await writeOwn(staging, "users.yml", "# the server's own\n")
    const out = await runHook(staging)
    assertEquals(out.code, 0, out.stderr)
    assertEquals(await usersIn(staging), "# the server's own\n")
    assertStringIncludes(await configurationIn(staging), "authentication_backend:\n")
  })
})

Deno.test("the generated configuration.yml holds no secret and no ${ placeholder", async () => {
  await withStaging(async (staging) => {
    const out = await runHook(staging, { ...ENV, ...SMTP_ENV })
    assertEquals(out.code, 0, out.stderr)
    const configuration = await configurationIn(staging)
    for (const secret of [SESSION_SECRET, STORAGE_KEY, JWT_SECRET, ADMIN_PASSWORD, SMTP_PASSWORD]) {
      assert(!configuration.includes(secret), `configuration.yml holds the secret ${secret}`)
    }
    assert(
      !configuration.includes("${"),
      `configuration.yml holds a placeholder:\n${configuration}`,
    )
    // Authelia must take these from the environment, so the file names none of them.
    for (const key of ["secret", "encryption_key", "jwt_secret", "password:"]) {
      assert(!configuration.includes(key), `configuration.yml sets "${key}":\n${configuration}`)
    }
  })
})

Deno.test("the first user's password and its hash never reach the deploy log, and the file holds only the hash", async () => {
  await withStaging(async (staging) => {
    const out = await runHook(staging)
    assertEquals(out.code, 0, out.stderr)
    const users = await usersIn(staging)
    assert(!users.includes(ADMIN_PASSWORD), "users.yml holds the password itself")
    const hash = users.match(/password: "(\$pbkdf2-sha512\$[^"]+)"/)?.[1]
    assert(hash, `users.yml holds no PBKDF2 hash:\n${users}`)
    const log = out.stdout + out.stderr
    assert(!log.includes(ADMIN_PASSWORD), "the log holds the password")
    assert(!log.includes(hash.split("$").at(-1)!), "the log holds the hash")
    assert(!log.includes(SESSION_SECRET), "the log holds the session secret")
  })
})

/** Bytes of Authelia's PBKDF2 base64: `.` in place of `+`, no padding. */
function fromAdaptedBase64(text: string): Buffer {
  return Buffer.from(text.replaceAll(".", "+"), "base64")
}

Deno.test("the first user's hash is the PBKDF2-SHA512 of AUTHELIA_ADMIN_PASSWORD in Authelia's format", async () => {
  // Several passwords, so that the hashes between them hold the `.` that Authelia's base64
  // writes where standard base64 has `+`.
  const hashes: string[] = []
  for (const password of [ADMIN_PASSWORD, "second password", "third-password", "p4"]) {
    await withStaging(async (staging) => {
      const out = await runHook(staging, { ...ENV, AUTHELIA_ADMIN_PASSWORD: password })
      assertEquals(out.code, 0, out.stderr)
      const line = (await usersIn(staging)).split("\n").find((l) => l.includes("password:"))
      assert(line, "users.yml has no password line")
      assertMatch(
        line,
        /^ {4}password: "\$pbkdf2-sha512\$310000\$[A-Za-z0-9.\/]{22}\$[A-Za-z0-9.\/]{86}"$/,
      )
      const [, , rounds, salt, hash] = line.slice(line.indexOf('"') + 1, -1).split("$")
      // Recomputed by Node's own PBKDF2, not by the code under test.
      const expected = pbkdf2Sync(password, fromAdaptedBase64(salt), Number(rounds), 64, "sha512")
      assertEquals(fromAdaptedBase64(hash).toString("hex"), expected.toString("hex"))
      hashes.push(salt + hash)
    })
  }
  assert(hashes.some((h) => h.includes(".")), "no hash exercised the `.` of Authelia's base64")
})

Deno.test("every run writes the same two files for the same settings, also in a fresh staging", async () => {
  const env = { ...ENV, ...SMTP_ENV }
  const read = async (staging: string) => [
    await configurationIn(staging),
    await usersIn(staging),
    await composeIn(staging),
  ]
  let first: string[] = []
  await withStaging(async (staging) => {
    assertEquals((await runHook(staging, env)).code, 0)
    first = await read(staging)
    const again = await runHook(staging, env)
    assertEquals(again.code, 0, again.stderr)
    assertEquals(await read(staging), first)
  })
  // Each deploy starts from a fresh staging folder: a file that differed there would restart
  // Authelia on every deploy.
  await withStaging(async (staging) => {
    assertEquals((await runHook(staging, env)).code, 0)
    assertEquals(await read(staging), first)
  })
})

Deno.test("another password gives another hash and another salt", async () => {
  const hashes: string[] = []
  for (const password of [ADMIN_PASSWORD, `${ADMIN_PASSWORD}x`]) {
    await withStaging(async (staging) => {
      const out = await runHook(staging, { ...ENV, AUTHELIA_ADMIN_PASSWORD: password })
      assertEquals(out.code, 0, out.stderr)
      hashes.push((await usersIn(staging)).match(/password: "([^"]+)"/)![1])
    })
  }
  const [a, b] = hashes.map((h) => h.split("$"))
  assert(a[3] !== b[3], "both passwords got the same salt")
  assert(a[4] !== b[4], "both passwords got the same hash")
})

Deno.test("password reset is off and codes go to a file when no SMTP server is set", async () => {
  await withStaging(async (staging) => {
    const out = await runHook(staging)
    assertEquals(out.code, 0, out.stderr)
    const configuration = await configurationIn(staging)
    assertStringIncludes(configuration, "  password_reset:\n    disable: true\n")
    assertStringIncludes(
      configuration,
      "notifier:\n  filesystem:\n    filename: /data/notifications.yml\n",
    )
    assert(!configuration.includes("smtp"), configuration)
  })
})

Deno.test("with an SMTP address and sender, password reset is on and mail goes through that server", async () => {
  await withStaging(async (staging) => {
    const out = await runHook(staging, { ...ENV, ...SMTP_ENV })
    assertEquals(out.code, 0, out.stderr)
    const configuration = await configurationIn(staging)
    assertStringIncludes(configuration, "  password_reset:\n    disable: false\n")
    assertStringIncludes(
      configuration,
      [
        "notifier:",
        "  smtp:",
        `    address: "submission://smtp.example.test:587"`,
        `    sender: "Authelia <auth@example.test>"`,
        `    username: "auth@example.test"`,
        "",
      ].join("\n"),
    )
    assert(!configuration.includes("filesystem"), configuration)
  })
})

Deno.test("an SMTP address without a sender, or a sender without an address, stops the deploy", async () => {
  for (const key of ["AUTHELIA_SMTP_ADDRESS", "AUTHELIA_SMTP_SENDER"]) {
    await withStaging(async (staging) => {
      const out = await runHook(staging, { ...ENV, [key]: SMTP_ENV[key] })
      assertEquals(out.code, 1, `${key} alone`)
      assertStringIncludes(out.stderr, "set both AUTHELIA_SMTP_ADDRESS and AUTHELIA_SMTP_SENDER")
    })
  }
})

Deno.test("a missing or blank secret stops the deploy, names the key and writes nothing", async () => {
  const keys = [
    "AUTHELIA_SESSION_SECRET",
    "AUTHELIA_STORAGE_ENCRYPTION_KEY",
    "AUTHELIA_IDENTITY_VALIDATION_RESET_PASSWORD_JWT_SECRET",
  ]
  for (const key of keys) {
    for (const blank of [false, true]) {
      await withStaging(async (staging) => {
        const env = { ...ENV }
        if (blank) env[key] = ""
        else delete env[key]
        const out = await runHook(staging, env)
        assertEquals(out.code, 1, `${key} ${blank ? "blank" : "missing"}`)
        assertStringIncludes(out.stderr, `missing in the server's .env: ${key}\n`)
        assertEquals(await filesUnder(staging), STAGED_BEFORE)
      })
    }
  }
})

Deno.test("without AUTHELIA_ADMIN_PASSWORD the deploy stops, unless the server brings its own users.yml", async () => {
  const env = { ...ENV }
  delete env.AUTHELIA_ADMIN_PASSWORD
  await withStaging(async (staging) => {
    const out = await runHook(staging, env)
    assertEquals(out.code, 1)
    assertStringIncludes(out.stderr, "AUTHELIA_ADMIN_PASSWORD")
    assertStringIncludes(out.stderr, "configs/authelia/users.yml")
    assert(
      !(await filesUnder(staging)).includes("configs/authelia/users.yml"),
      "a users.yml was written without a password",
    )
  })
  await withStaging(async (staging) => {
    await writeOwn(staging, "users.yml", "# the server's own\n")
    const out = await runHook(staging, env)
    assertEquals(out.code, 0, out.stderr)
    assertEquals(await usersIn(staging), "# the server's own\n")
  })
})

Deno.test("with AUTHELIA_SMTP_PASSWORD the staged compose.yml hands it to Authelia under its own name", async () => {
  await withStaging(async (staging) => {
    const env = { ...ENV, ...SMTP_ENV }
    const out = await runHook(staging, env)
    assertEquals(out.code, 0, out.stderr)
    const environment = environmentOf(await composeIn(staging), env)
    assert(
      environment.includes(`AUTHELIA_NOTIFIER_SMTP_PASSWORD=${SMTP_PASSWORD}`),
      `not in: ${environment}`,
    )
    assert(!(await composeIn(staging)).includes(SMTP_PASSWORD), "compose.yml holds the password")
  })
})

Deno.test("without AUTHELIA_SMTP_PASSWORD the hook changes only the config-hash line of compose.yml, and no SMTP variable appears", async () => {
  // Authelia takes even an empty AUTHELIA_NOTIFIER_SMTP_PASSWORD as an SMTP notifier and refuses
  // to start beside the file notifier.
  await withStaging(async (staging) => {
    const before = await composeIn(staging)
    const out = await runHook(staging)
    assertEquals(out.code, 0, out.stderr)
    const after = await composeIn(staging)
    assertEquals(
      after.replace(`- "${CONFIG_HASH_LABEL}=${configHashOf(after)}"`, CONFIG_HASH_MARKER),
      before,
    )
    const names = environmentOf(after, ENV).map((item) => item.slice(0, item.indexOf("=")))
    assertEquals(names.filter((name) => name.includes("SMTP")), [])
  })
})

Deno.test("the authelia service gets a config-hash label that changes when either config file changes, and only then", async () => {
  // The two files are single-file mounts: a deploy that replaces one leaves the running container
  // on the old file, and compose recreates the container only when its own definition changed.
  const hashFor = async (
    env: Record<string, string>,
    own: Record<string, string> = {},
  ): Promise<string> => {
    let hash = ""
    await withStaging(async (staging) => {
      for (const [name, text] of Object.entries(own)) await writeOwn(staging, name, text)
      const out = await runHook(staging, env)
      assertEquals(out.code, 0, out.stderr)
      const compose = await composeIn(staging)
      hash = configHashOf(compose)
      // A label of the authelia service: in its `labels:` list, before the next service.
      const label = compose.indexOf(`      - "${CONFIG_HASH_LABEL}=`)
      assert(label > compose.indexOf("    labels:"), "the hash is not under labels:")
      assert(
        label < compose.indexOf("  authelia-redis:"),
        "the hash is not on the authelia service",
      )
    })
    return hash
  }
  const base = await hashFor(ENV)
  assertEquals(await hashFor(ENV), base, "the same settings gave another hash")
  const password = await hashFor({ ...ENV, AUTHELIA_ADMIN_PASSWORD: `${ADMIN_PASSWORD}x` })
  assert(password !== base, "a changed first password kept the hash")
  const domain = await hashFor({ ...ENV, AUTHELIA_DOMAIN: "login.${DOMAIN}" })
  assert(domain !== base && domain !== password, "a changed configuration.yml kept the hash")
  const ownUsers = await hashFor(ENV, { "users.yml": "users: {}\n" })
  const ownUsersEdited = await hashFor(ENV, { "users.yml": "users: {} # edited\n" })
  assert(ownUsers !== ownUsersEdited, "an edit of the server's own users.yml kept the hash")
  const ownConfig = await hashFor(ENV, { "configuration.yml": "theme: dark\n" })
  const ownConfigEdited = await hashFor(ENV, { "configuration.yml": "theme: light\n" })
  assert(ownConfig !== ownConfigEdited, "an edit of the server's own configuration.yml kept it")
})

Deno.test("an SMTP password without an SMTP server stops the deploy when the config is generated", async () => {
  await withStaging(async (staging) => {
    const out = await runHook(staging, { ...ENV, AUTHELIA_SMTP_PASSWORD: SMTP_PASSWORD })
    assertEquals(out.code, 1)
    assertStringIncludes(out.stderr, "AUTHELIA_SMTP_PASSWORD is set without AUTHELIA_SMTP_ADDRESS")
    assert(!(out.stdout + out.stderr).includes(SMTP_PASSWORD), "the log holds the SMTP password")
  })
})

Deno.test("the server's own configuration.yml gets the SMTP password too, with no SMTP setting in .env", async () => {
  await withStaging(async (staging) => {
    await writeOwn(staging, "configuration.yml", "# the server's own, with its own notifier\n")
    const env = { ...ENV, AUTHELIA_SMTP_PASSWORD: SMTP_PASSWORD }
    const out = await runHook(staging, env)
    assertEquals(out.code, 0, out.stderr)
    assert(
      environmentOf(await composeIn(staging), env).includes(
        `AUTHELIA_NOTIFIER_SMTP_PASSWORD=${SMTP_PASSWORD}`,
      ),
    )
  })
})

Deno.test("a compose.yml without the marker stops the deploy instead of dropping the SMTP password", async () => {
  await withStaging(async (staging) => {
    const path = join(staging, "stacks", "authelia", "compose.yml")
    const compose = await Deno.readTextFile(path)
    assertStringIncludes(compose, SMTP_PASSWORD_MARKER)
    await Deno.writeTextFile(path, compose.replace(SMTP_PASSWORD_MARKER, "# removed"))
    const out = await runHook(staging, { ...ENV, ...SMTP_ENV })
    assertEquals(out.code, 1)
    assertStringIncludes(out.stderr, `must hold the line "${SMTP_PASSWORD_MARKER}" exactly once`)
  })
})
