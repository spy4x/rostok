// Runs the hook the way deploy does: from a file URL or path elsewhere, with cwd = a staging
// folder holding `stacks/searxng/`.

import { assertEquals, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"

Deno.test("searxng before.deploy.ts: renders settings.yml from the staging folder, not the hook's own location", async () => {
  const staging = await Deno.makeTempDir()
  try {
    await Deno.mkdir(join(staging, "stacks/searxng"), { recursive: true })
    await Deno.writeTextFile(
      join(staging, "stacks/searxng/searxng-settings.yml"),
      'secret_key: "${SEARXNG_SECRET_KEY}"\n',
    )
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", import.meta.resolve("./before.deploy.ts")],
      cwd: staging,
      clearEnv: true,
      env: { SEARXNG_SECRET_KEY: "s3cret" },
      stdout: "piped",
      stderr: "piped",
    }).output()
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr))
    const rendered = await Deno.readTextFile(join(staging, "stacks/searxng/settings.yml"))
    assertStringIncludes(rendered, 'secret_key: "s3cret"')
  } finally {
    await Deno.remove(staging, { recursive: true })
  }
})
