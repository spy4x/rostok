import { assertEquals, assertStringIncludes } from "@std/assert"

const hook = new URL("./before.deploy.ts", import.meta.url).href

/** Runs the hook with `cwd` as the staging directory; returns its exit code and stdout. */
async function runHook(cwd: string): Promise<{ code: number; stdout: string }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", hook],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output()
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) }
}

/** A staging directory holding the starter config, plus the server override when given. */
async function stage(override?: string): Promise<string> {
  const dir = await Deno.makeTempDir()
  await Deno.mkdir(`${dir}/stacks/zond`, { recursive: true })
  await Deno.writeTextFile(`${dir}/stacks/zond/config.yml`, "starter\n")
  if (override !== undefined) {
    await Deno.mkdir(`${dir}/configs`)
    await Deno.writeTextFile(`${dir}/configs/zond.yaml`, override)
  }
  return dir
}

Deno.test("zond before.deploy: the server's configs/zond.yaml replaces the starter", async () => {
  const dir = await stage("targets: []\n")
  try {
    const { code } = await runHook(dir)
    assertEquals(code, 0)
    assertEquals(await Deno.readTextFile(`${dir}/stacks/zond/config.yml`), "targets: []\n")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test("zond before.deploy: without a server config the starter stays", async () => {
  const dir = await stage()
  try {
    const { code, stdout } = await runHook(dir)
    assertEquals(code, 0)
    assertStringIncludes(stdout, "using the starter")
    assertEquals(await Deno.readTextFile(`${dir}/stacks/zond/config.yml`), "starter\n")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
