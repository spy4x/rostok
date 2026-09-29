// Runs the hook the way deploy does: from a file URL or path elsewhere, with cwd = a staging
// folder holding `stacks/piped/`.

import { assertEquals, assertStringIncludes } from "@std/assert"
import { join } from "@std/path"

Deno.test("piped before.deploy.ts: renders config.properties from the staging folder, not the hook's own location", async () => {
  const staging = await Deno.makeTempDir()
  try {
    await Deno.mkdir(join(staging, "stacks/piped"), { recursive: true })
    await Deno.writeTextFile(
      join(staging, "stacks/piped/config.properties.template"),
      "API_URL: https://pipedapi.${DOMAIN}\nuser: ${PIPED_DB_USER}\n",
    )
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", import.meta.resolve("./before.deploy.ts")],
      cwd: staging,
      clearEnv: true,
      env: { DOMAIN: "example.com", PIPED_DB_USER: "piped" },
      stdout: "piped",
      stderr: "piped",
    }).output()
    const err = new TextDecoder().decode(out.stderr)
    assertEquals(out.code, 0, err)
    const rendered = await Deno.readTextFile(join(staging, "stacks/piped/config.properties"))
    assertStringIncludes(rendered, "API_URL: https://pipedapi.example.com")
    assertStringIncludes(rendered, "user: piped")
  } finally {
    await Deno.remove(staging, { recursive: true })
  }
})
