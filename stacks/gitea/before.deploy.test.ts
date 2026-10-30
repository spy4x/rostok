// Tests the Postgres 18 guard shared by gitea, umami and caldiy (#363).

import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import { buildCheckScript, buildCommand, check, REFUSE, stackFromUrl } from "./before.deploy.ts"

/** A temp VOLUMES_PATH with the given folders made inside it. */
async function volumes(...dirs: string[]): Promise<string> {
  const root = await Deno.makeTempDir()
  for (const dir of dirs) await Deno.mkdir(`${root}/${dir}`, { recursive: true })
  return root
}

/** Exit code of the check script run with the local `sh`. */
async function runCheck(volumesPath: string, stack: string): Promise<number> {
  const script = buildCheckScript(volumesPath, stack)
  return (await new Deno.Command("sh", { args: ["-c", script], stdout: "null" }).output()).code
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
    assertStringIncludes(message, `sh upgrade.sh ${root} umami`)
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
    assertStringIncludes(new TextDecoder().decode(out.stderr), `sh upgrade.sh ${root} caldiy`)
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
