// End-to-end smoke test for the rostok CLI.
//
// Walks the same path a user would on a fresh install:
//
//   1. runWizard (init + server create) — non-interactive, with defaults.
//   2. stackAdd — non-interactive, against a small fixture catalog.
//   3. validateDeployArgs — pre-flight the deploy command.
//
// Uses a fixture catalog (written to a temp dir, loaded via `--catalog`)
// rather than the real bundled catalog: the real `stacks/*/+meta.ts`
// variable names are being renamed in a sibling PR, and this test's job
// is to exercise the CLI's own logic, not the catalog's current key
// names.
//
// Verifies the file tree matches docs/design/v1-cli.md §5. Then runs
// `deno run -A cli/+main.ts --help` and asserts the output starts with
// "Usage: rostok" (golden file for the root --help).
//
// Kept deliberately small — this is a smoke test, not coverage. The
// fine-grained invariants live in unit tests next to each module.

import { assertEquals, assertExists } from "@std/assert"
import { join } from "@std/path"
import { runWizard } from "../wizard.ts"
import { stackAdd } from "../stack-add.ts"
import { validateDeployArgs } from "../commands/deploy.ts"

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-smoke-" })
  try {
    return await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {})
  }
}

const DEMO_META = `import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "demo",
  description: "Fixture stack for the CLI smoke test",
  category: "test",
  variables: [
    { key: "DEMO_IMAGE_TAG", default: "1.0", required: false },
    {
      key: "DEMO_DOMAIN",
      question: "Public domain for demo?",
      default: "demo.\${DOMAIN}",
      required: true,
    },
    { key: "CONTACT_EMAIL", question: "Contact email?", required: true },
    { key: "DEMO_CPU_LIMIT", question: "CPU limit?", default: "1", required: true },
    { key: "DEMO_MEM_LIMIT", question: "Memory limit?", default: "512M", required: true },
    {
      key: "DEMO_PASSWORD",
      question: "Password?",
      default: () => generatePassword(24),
      required: true,
      secret: true,
    },
  ],
} satisfies StackMeta
`

/** Write a one-stack fixture catalog to `<dir>/catalog/demo/+meta.ts`. Returns the catalog dir. */
async function writeFixtureCatalog(dir: string): Promise<string> {
  const catalogDir = join(dir, "catalog")
  await Deno.mkdir(join(catalogDir, "demo"), { recursive: true })
  await Deno.writeTextFile(join(catalogDir, "demo", "+meta.ts"), DEMO_META)
  return catalogDir
}

const SERVER_INPUTS = {
  serverName: "home",
  sshTarget: "homelab",
  user: "deploy",
  domain: "example.test",
  contactEmail: "ops@example.test",
  project: "hl",
  dockerGroupId: "990",
  timezone: "UTC",
  puid: "1000",
  pgid: "1000",
  volumesPath: "/srv/volumes",
  pathApps: "/srv/apps",
}

Deno.test("smoke: wizard writes the v1 project skeleton", async () => {
  await withTmpDir(async (dir) => {
    const result = await runWizard({
      cwd: dir,
      nonInteractive: true,
      serverInputs: SERVER_INPUTS,
      skipStackAdd: true,
    })

    // 1. wizard completed
    assertEquals(result.serverName, "home")

    // 2. file tree matches §5
    for (
      const rel of [
        "deno.jsonc",
        ".gitignore",
        ".env.root",
        "servers/home/.env",
      ]
    ) {
      assertExists(await Deno.stat(join(dir, rel)).catch(() => null), rel)
    }

    // 3. deno.jsonc has the @rostok/cli import map per §5
    const denoJsonc = await Deno.readTextFile(join(dir, "deno.jsonc"))
    assertEquals(
      denoJsonc.includes(`"@rostok/cli"`),
      true,
      "deno.jsonc must map @rostok/cli",
    )

    // 4. .gitignore excludes plaintext .env / .env.root / the age key
    const gitignore = await Deno.readTextFile(join(dir, ".gitignore"))
    assertEquals(gitignore.includes(".env"), true)
    assertEquals(gitignore.includes(".env.root"), true)
    assertEquals(gitignore.includes(".age/"), true)

    // 5. #206: servers/home/.env carries every DEPLOY_REQUIRED_KEYS key.
    const env = await Deno.readTextFile(join(dir, "servers", "home", ".env"))
    for (
      const key of [
        "SSH_ADDRESS",
        "SSH_USER",
        "PATH_APPS",
        "VOLUMES_PATH",
        "PUID",
        "PGID",
        "DOCKER_GROUP_ID",
      ]
    ) {
      assertEquals(env.includes(`${key}=`), true, `missing ${key}`)
    }
    assertEquals(env.includes("SSH_USER=deploy"), true)
  })
})

Deno.test("smoke: stack add writes .env + config.json", async () => {
  await withTmpDir(async (dir) => {
    await runWizard({
      cwd: dir,
      nonInteractive: true,
      serverInputs: SERVER_INPUTS,
      skipStackAdd: true,
    })

    const catalogDir = await writeFixtureCatalog(dir)

    const result = await stackAdd("demo", "home", {
      cwd: dir,
      catalogDir,
      nonInteractive: true,
      // CONTACT_EMAIL isn't overridden — it's already in servers/home/.env
      // (server-create wrote it), and #210 says stack add keeps it.
    })
    assertEquals(result.stackName, "demo")
    assertEquals(result.serverName, "home")
    // demo declares 6 vars, all required (or defaulted) — CONTACT_EMAIL
    // comes from the existing .env, so nothing is skipped.
    assertEquals(result.writtenEntries.length, 6)
    assertEquals(result.skippedKeys.length, 0)

    // config.json has the demo entry
    const configPath = join(dir, "servers", "home", "config.json")
    const cfg = JSON.parse(await Deno.readTextFile(configPath))
    assertEquals(cfg.stacks[0].name, "demo")

    // .env has the declared keys, ${DOMAIN} resolved, CONTACT_EMAIL kept
    // from server-create rather than re-asked.
    const env = await Deno.readTextFile(join(dir, "servers", "home", ".env"))
    assertEquals(env.includes("CONTACT_EMAIL=ops@example.test"), true)
    assertEquals(env.includes("DEMO_DOMAIN=demo.example.test"), true)
    assertEquals(env.includes("DEMO_CPU_LIMIT=1"), true)

    // No duplicate keys after merge.
    const keys = env.split("\n").filter((l) => l && !l.startsWith("#"))
      .map((l) => l.slice(0, l.indexOf("=")))
    assertEquals(new Set(keys).size, keys.length, "no duplicate keys in .env")
  })
})

Deno.test("smoke: re-running stack add keeps the generated secret", async () => {
  await withTmpDir(async (dir) => {
    await runWizard({
      cwd: dir,
      nonInteractive: true,
      serverInputs: SERVER_INPUTS,
      skipStackAdd: true,
    })
    const catalogDir = await writeFixtureCatalog(dir)

    await stackAdd("demo", "home", { cwd: dir, catalogDir, nonInteractive: true })
    const envPath = join(dir, "servers", "home", ".env")
    const firstPassword = (await Deno.readTextFile(envPath))
      .split("\n").find((l) => l.startsWith("DEMO_PASSWORD="))

    const second = await stackAdd("demo", "home", { cwd: dir, catalogDir, nonInteractive: true })
    const secondPassword = (await Deno.readTextFile(envPath))
      .split("\n").find((l) => l.startsWith("DEMO_PASSWORD="))

    assertEquals(secondPassword, firstPassword, "DEMO_PASSWORD must not rotate on re-run")
    // Every key was already present — all 6 kept, none new.
    assertEquals(second.newCount, 0)
    assertEquals(second.keptCount, 6)
  })
})

Deno.test("smoke: deploy pre-flight surfaces missing server", async () => {
  await withTmpDir(async (dir) => {
    const result = await validateDeployArgs(dir, "missing", undefined)
    assertEquals(result.ok, false)
    assertEquals(
      result.error?.includes("server 'missing' not found"),
      true,
      "should name the missing server",
    )
  })
})

Deno.test("smoke: deploy pre-flight surfaces unknown stack", async () => {
  await withTmpDir(async (dir) => {
    await runWizard({
      cwd: dir,
      nonInteractive: true,
      serverInputs: SERVER_INPUTS,
      skipStackAdd: true,
    })
    // Seed an empty config.json (no stacks).
    await Deno.writeTextFile(
      join(dir, "servers", "home", "config.json"),
      `{"stacks":[]}`,
    )
    const result = await validateDeployArgs(dir, "home", "traefik")
    assertEquals(result.ok, false)
    assertEquals(
      result.error?.includes("no stacks"),
      true,
      "should explain that no stacks are configured",
    )
  })
})

Deno.test("smoke: --help renders the Usage banner", async () => {
  const mainTs = new URL("../+main.ts", import.meta.url).pathname
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", mainTs, "--help"],
    // --help runs nothing by name, so the child gets an empty PATH: no
    // e2e child can ever reach the host's rsync (#249).
    env: { PATH: "" },
    stdout: "piped",
    stderr: "piped",
  })
  const out = await cmd.output()
  const stdout = new TextDecoder().decode(out.stdout)
  assertEquals(out.success, true)
  // Cliffy renders "Usage:" as the first heading.
  assertEquals(stdout.includes("Usage:"), true)
  assertEquals(stdout.includes("rostok"), true)
})
