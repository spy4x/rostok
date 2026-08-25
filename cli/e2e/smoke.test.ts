// End-to-end smoke test for the rostok CLI.
//
// Walks the same path a user would on a fresh install:
//
//   1. runWizard (init + server create) — non-interactive, with defaults.
//   2. stackAdd — non-interactive, with --var overrides for required vars.
//   3. validateDeployArgs — pre-flight the deploy command.
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

// Resolve the repo's stacks/ directory at test time. `defaultCatalogDir`
// walks up 5 levels from cwd — fine when running the CLI from the repo,
// useless from /tmp. Tests pass it explicitly so they don't depend on
// the tmp dir's location.
const CATALOG_DIR = new URL("../../stacks", import.meta.url).pathname

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rostok-smoke-" })
  try {
    return await fn(dir)
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {})
  }
}

Deno.test("smoke: wizard writes the v1 project skeleton", async () => {
  await withTmpDir(async (dir) => {
    const result = await runWizard({
      cwd: dir,
      nonInteractive: true,
      serverInputs: {
        // server-create inputs
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
      },
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

    // 4. .gitignore excludes plaintext .env / .env.root
    const gitignore = await Deno.readTextFile(join(dir, ".gitignore"))
    assertEquals(gitignore.includes(".env"), true)
    assertEquals(gitignore.includes(".env.root"), true)
  })
})

Deno.test("smoke: stack add writes .env + config.json", async () => {
  await withTmpDir(async (dir) => {
    await runWizard({
      cwd: dir,
      nonInteractive: true,
      serverInputs: {
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
      },
      skipStackAdd: true,
    })

    const result = await stackAdd("traefik", "home", {
      cwd: dir,
      catalogDir: CATALOG_DIR,
      nonInteractive: true,
      providedVars: {
        // CONTACT_EMAIL has no default in traefik/+meta.ts; required.
        CONTACT_EMAIL: "ops@example.test",
        // PROXY_DOMAIN defaults to `traefik.${DOMAIN}` (server-side
        // resolved); override or accept default.
      },
    })
    assertEquals(result.stackName, "traefik")
    assertEquals(result.serverName, "home")
    // traefik declares IMAGE_TAG + PROXY_DOMAIN + CONTACT_EMAIL +
    // PROXY_CPU_LIMIT + PROXY_MEM_LIMIT (5 vars).
    assertEquals(result.writtenEntries.length >= 5, true)

    // config.json has the traefik entry
    const configPath = join(dir, "servers", "home", "config.json")
    const cfg = JSON.parse(await Deno.readTextFile(configPath))
    assertEquals(cfg.stacks[0].name, "traefik")

    // .env has the declared keys
    const env = await Deno.readTextFile(join(dir, "servers", "home", ".env"))
    assertEquals(env.includes("CONTACT_EMAIL=ops@example.test"), true)
    assertEquals(env.includes("PROXY_DOMAIN=traefik.example.test"), true)
    assertEquals(env.includes("PROXY_CPU_LIMIT=1"), true)

    // No duplicate keys after server-level propagation (regression:
    // mergeEnv was called with propagated.concat(existing) as the base,
    // so server-level keys appeared twice).
    const keys = env.split("\n").filter((l) => l && !l.startsWith("#"))
      .map((l) => l.slice(0, l.indexOf("=")))
    assertEquals(new Set(keys).size, keys.length, "no duplicate keys in .env")
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
      serverInputs: {
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
      },
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
