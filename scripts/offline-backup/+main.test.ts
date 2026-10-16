import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"

const MAIN = fromFileUrl(new URL("./+main.ts", import.meta.url))

/**
 * Runs the entry point, by default with an unknown command, so it stops right
 * after the settings check and never reaches a drive. The child gets only the
 * variables Deno itself needs plus `extraEnv`, and no terminal on stdin.
 */
async function run(
  cwd: string,
  extraEnv: Record<string, string>,
  args: string[] = ["no-such-command"],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: Record<string, string> = { ...extraEnv }
  for (const key of ["HOME", "DENO_DIR", "PATH"]) {
    const value = Deno.env.get(key)
    if (value !== undefined) env[key] = value
  }
  const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, ...args],
    cwd,
    clearEnv: true,
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output()
  const decoder = new TextDecoder()
  return { code, stdout: decoder.decode(stdout), stderr: decoder.decode(stderr) }
}

Deno.test("ignores .env.root and .env in the working directory", async () => {
  const cwd = await Deno.makeTempDir()
  try {
    const settings = "BACKUP_PATHS=/tmp/a:/tmp/b\nBACKUPS_PASSWORD=placeholder\n"
    await Deno.writeTextFile(`${cwd}/.env.root`, settings)
    await Deno.writeTextFile(`${cwd}/.env`, settings)
    const { code, stderr } = await run(cwd, {})
    assertEquals(code, 1)
    assertStringIncludes(
      stderr,
      "Missing required environment variables: BACKUP_PATHS, BACKUPS_PASSWORD",
    )
  } finally {
    await Deno.remove(cwd, { recursive: true })
  }
})

Deno.test("takes its settings from the process environment", async () => {
  const cwd = await Deno.makeTempDir()
  try {
    const { code, stderr } = await run(cwd, {
      BACKUP_PATHS: "/tmp/a:/tmp/b",
      BACKUPS_PASSWORD: "placeholder",
    })
    assertEquals(code, 1)
    assertStringIncludes(stderr, "Unknown command: no-such-command")
  } finally {
    await Deno.remove(cwd, { recursive: true })
  }
})

Deno.test("help needs no settings and lists the flags", async () => {
  const cwd = await Deno.makeTempDir()
  try {
    const { code, stdout } = await run(cwd, {}, ["help"])
    assertEquals(code, 0)
    assertStringIncludes(stdout, "--drive <name>")
    assertStringIncludes(stdout, "--delete-missing")
  } finally {
    await Deno.remove(cwd, { recursive: true })
  }
})

Deno.test("an unknown flag exits 2 before touching any drive", async () => {
  const cwd = await Deno.makeTempDir()
  try {
    // No settings either: a wrong flag is reported before missing settings.
    const { code, stderr } = await run(cwd, {}, ["create", "--force"])
    assertEquals(code, 2)
    assertStringIncludes(stderr, "Unknown argument: --force")
  } finally {
    await Deno.remove(cwd, { recursive: true })
  }
})

Deno.test("create without a terminal and without --drive exits 2 and names --drive", async () => {
  const cwd = await Deno.makeTempDir()
  try {
    const paths = JSON.stringify([{ source: cwd, target: "target" }])
    const { code, stderr } = await run(
      cwd,
      { BACKUP_PATHS: paths, BACKUPS_PASSWORD: "placeholder" },
      ["create"],
    )
    assertEquals(code, 2)
    assertStringIncludes(stderr, "pass --drive <name>")
  } finally {
    await Deno.remove(cwd, { recursive: true })
  }
})
