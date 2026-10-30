// Tests the Postgres 18 guard shared by gitea, umami and caldiy (#363).

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import {
  buildCheckScript,
  buildCommand,
  CANNOT_ENTER,
  check,
  deployTargetHost,
  INCOMPLETE,
  oldTagRefusal,
  REFUSE,
  stackFromUrl,
} from "./before.deploy.ts"

/** A temp VOLUMES_PATH with the given folders made inside it. */
async function volumes(...dirs: string[]): Promise<string> {
  const root = await Deno.makeTempDir()
  for (const dir of dirs) await Deno.mkdir(`${root}/${dir}`, { recursive: true })
  return root
}

/** Exit code of the check script run with the local `sh`, with `env` added. */
async function runCheck(
  volumesPath: string,
  stack: string,
  env: Record<string, string> = {},
): Promise<number> {
  const script = buildCheckScript(volumesPath, stack)
  return (await new Deno.Command("sh", { args: ["-c", script], env, stdout: "null" }).output()).code
}

/**
 * A PATH whose first folder (inside `root`) holds a fake `id` that prints `uid` and a fake
 * `sudo` that exits `sudoCode` when called with `-n`, so no test reaches the real sudo.
 */
async function fakePath(root: string, uid: string, sudoCode: number): Promise<string> {
  const bin = `${root}/fake-bin`
  await Deno.mkdir(bin)
  const guard = `[ -z "$FAKE_BIN_DEPTH" ] || exit 99; export FAKE_BIN_DEPTH=1`
  const write = (name: string, body: string) =>
    Deno.writeTextFile(`${bin}/${name}`, `#!/bin/sh\n${guard}\n${body}\n`, { mode: 0o755 })
  await write("id", `echo ${uid}`)
  await write("sudo", `echo "sudo: fake" >&2; [ "$1" = -n ] || exit 98; exit ${sudoCode}`)
  return `${bin}:${Deno.env.get("PATH")}`
}

const cases: { name: string; dirs: string[]; code: number }[] = [
  { name: "passes a fresh install with no stack folder", dirs: [], code: 0 },
  { name: "passes a stack folder without the old db folder", dirs: ["gitea/data"], code: 0 },
  { name: "refuses while only the old db folder exists", dirs: ["gitea/db"], code: REFUSE },
  {
    name: "refuses when the new folder exists but holds no data",
    dirs: ["gitea/db", "gitea/postgres"],
    code: REFUSE,
  },
  {
    name: "passes once the new folder holds Postgres 18 data",
    dirs: ["gitea/db", "gitea/postgres/18/docker"],
    code: 0,
  },
  {
    name: "passes after the upgrade moved the old folder",
    dirs: ["gitea/postgres/18/docker"],
    code: 0,
  },
]

for (const c of cases) {
  Deno.test(`postgres guard: ${c.name}`, async () => {
    const root = await volumes(...c.dirs)
    try {
      assertEquals(await runCheck(root, "gitea"), c.code)
    } finally {
      await Deno.remove(root, { recursive: true })
    }
  })
}

Deno.test("postgres guard: a path with a quote and spaces stays one argument", async () => {
  const root = await volumes("it's a dir/gitea/db")
  try {
    assertEquals(await runCheck(`${root}/it's a dir`, "gitea"), REFUSE)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("postgres guard: a local server gets the refusal naming the upgrade step", async () => {
  const root = await volumes("umami/db")
  try {
    const env = (key: string) =>
      ({ VOLUMES_PATH: root, SSH_LOCAL: "true" } as Record<string, string>)[key]
    const message = await check(env, "umami")
    assert(message !== undefined)
    assertStringIncludes(message, `sudo sh upgrade.sh ${root} umami`)
    assertStringIncludes(message, "docs/usage/postgres-upgrade.md")
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("postgres guard: refuses to check without VOLUMES_PATH", async () => {
  const env = (key: string) => ({ SSH_LOCAL: "true" } as Record<string, string>)[key]
  assertEquals(await check(env, "gitea"), "VOLUMES_PATH is not set")
})

Deno.test("postgres guard: the hook run by deploy fails the deploy with the message", async () => {
  const root = await volumes("caldiy/db")
  try {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", new URL("../caldiy/before.deploy.ts", import.meta.url).href],
      env: { VOLUMES_PATH: root, SSH_LOCAL: "true", SSH_HOST: "" },
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(out.code, 1)
    assertStringIncludes(new TextDecoder().decode(out.stderr), `sudo sh upgrade.sh ${root} caldiy`)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("postgres guard: ssh gets the port, BatchMode and `--` before the host", () => {
  assertEquals(buildCommand("host.example", "2222", "deploy", "exit 0"), {
    cmd: "ssh",
    args: [
      "-p",
      "2222",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "BatchMode=yes",
      "--",
      "deploy@host.example",
      "exit 0",
    ],
  })
  assertThrows(() => buildCommand("host.example", "22; rm", undefined, "exit 0"))
})

Deno.test("postgres guard: the stack name comes from a file or jsr.io URL", () => {
  assertEquals(stackFromUrl("file:///p/stacks/gitea/before.deploy.ts"), "gitea")
  assertEquals(
    stackFromUrl("https://jsr.io/@rostok/cli/1.21.0/stacks/caldiy/before.deploy.ts"),
    "caldiy",
  )
  assertThrows(() => stackFromUrl("file:///tmp/before.deploy.ts"))
})

Deno.test("postgres guard: umami and caldiy ship the same file as gitea", async () => {
  const read = (stack: string) =>
    Deno.readTextFile(new URL(`../${stack}/before.deploy.ts`, import.meta.url))
  const gitea = await read("gitea")
  assertEquals(await read("umami"), gitea)
  assertEquals(await read("caldiy"), gitea)
})

Deno.test("postgres guard: refuses while an upgrade did not finish", async () => {
  const root = await volumes("gitea/postgres/18/docker")
  try {
    await Deno.writeTextFile(`${root}/gitea/postgres/.upgrade-incomplete`, "kept\n")
    assertEquals(await runCheck(root, "gitea"), INCOMPLETE)
    const env = (key: string) =>
      ({ VOLUMES_PATH: root, SSH_LOCAL: "true" } as Record<string, string>)[key]
    const message = await check(env, "gitea")
    assert(message !== undefined)
    assertStringIncludes(message, "did not finish")
    assertStringIncludes(message, `sudo sh upgrade.sh ${root} gitea`)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("postgres guard: a DB tag of Postgres 17 or older is refused", () => {
  for (const tag of ["16", "16.9", "16-alpine", "16.9@sha256:abc", "17.2-alpine"]) {
    const message = oldTagRefusal("gitea", tag)
    assert(message !== undefined, tag)
    assertStringIncludes(message, `GITEA_DB_IMAGE_TAG=${tag}`)
  }
  for (const tag of [undefined, "18-alpine", "18.6", "19", "latest", "latest@sha256:abc"]) {
    assertEquals(oldTagRefusal("gitea", tag), undefined, tag)
  }
})

Deno.test("postgres guard: a pinned Postgres 16 tag fails even after the upgrade", async () => {
  const root = await volumes("caldiy/postgres/18/docker")
  try {
    const env = (key: string) =>
      ({ VOLUMES_PATH: root, SSH_LOCAL: "true", CALDIY_DB_IMAGE_TAG: "16.9" } as Record<
        string,
        string
      >)[key]
    const message = await check(env, "caldiy")
    assert(message !== undefined)
    assertStringIncludes(message, "CALDIY_DB_IMAGE_TAG=16.9 names Postgres 16")
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("postgres guard: a VOLUMES_PATH it cannot enter is an error for root", async () => {
  // A regular file on the path blocks root too, unlike a mode-000 folder.
  const root = await volumes()
  try {
    await Deno.writeTextFile(`${root}/file`, "")
    const env = { PATH: await fakePath(root, "0", REFUSE) }
    assertEquals(await runCheck(`${root}/file/volumes`, "gitea", env), CANNOT_ENTER)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("postgres guard: a user that is not root asks sudo and uses its answer", async () => {
  const root = await volumes()
  try {
    await Deno.writeTextFile(`${root}/file`, "")
    const env = { PATH: await fakePath(root, "1000", REFUSE) }
    assertEquals(await runCheck(`${root}/file/volumes`, "gitea", env), REFUSE)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("postgres guard: the deploy fails when sudo cannot check either", async () => {
  const root = await volumes()
  try {
    await Deno.writeTextFile(`${root}/file`, "")
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", new URL("./before.deploy.ts", import.meta.url).href],
      env: {
        VOLUMES_PATH: `${root}/file/volumes`,
        SSH_LOCAL: "true",
        SSH_HOST: "",
        PATH: await fakePath(root, "1000", 1),
      },
      stdout: "piped",
      stderr: "piped",
    }).output()
    const stderr = new TextDecoder().decode(out.stderr)
    assertEquals(out.code, 1, stderr)
    assertStringIncludes(stderr, "could not check the Postgres data folders (exit 1)")
    assertStringIncludes(stderr, `cannot enter ${root}/file`)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})

Deno.test("postgres guard: no SSH_HOST checks this machine only when deploy says local", () => {
  const envOf = (vars: Record<string, string>) => (key: string) => vars[key]
  assertThrows(() => deployTargetHost(envOf({})), Error, "SSH_LOCAL is not true")
  assertThrows(() => deployTargetHost(envOf({ SSH_LOCAL: "false" })))
  assertEquals(deployTargetHost(envOf({ SSH_LOCAL: "true" })), undefined)
  assertEquals(deployTargetHost(envOf({ SSH_HOST: "host.example" })), "host.example")
})
