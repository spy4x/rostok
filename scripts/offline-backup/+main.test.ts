import { assertEquals, assertStringIncludes } from "@std/assert"
import { fromFileUrl } from "@std/path"

const MAIN = fromFileUrl(new URL("./+main.ts", import.meta.url))

/**
 * Runs the entry point with an unknown command, so it stops right after the
 * settings check and never reaches a drive. The child gets only the variables
 * Deno itself needs plus `extraEnv`.
 */
async function run(
  cwd: string,
  extraEnv: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  const env: Record<string, string> = { ...extraEnv }
  for (const key of ["HOME", "DENO_DIR", "PATH"]) {
    const value = Deno.env.get(key)
    if (value !== undefined) env[key] = value
  }
  const { code, stderr } = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", MAIN, "no-such-command"],
    cwd,
    clearEnv: true,
    env,
    stdout: "null",
    stderr: "piped",
  }).output()
  return { code, stderr: new TextDecoder().decode(stderr) }
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
