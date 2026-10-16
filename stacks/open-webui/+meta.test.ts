// open-webui-specific checks. The checks every +meta.ts shares live in stacks/meta.test.ts.

import { assertEquals } from "@std/assert"
import { join } from "@std/path"
import { readEnvFile } from "../../cli/env-files.ts"
import { stackAdd } from "../../cli/stack-add.ts"

Deno.test("open-webui +meta.ts: stack add -n with default answers succeeds without a model provider (spy4x/rostok#426)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "rostok-open-webui-add-" })
  try {
    const serverDir = join(dir, "servers", "test")
    await Deno.mkdir(serverDir, { recursive: true })
    await Deno.writeTextFile(join(serverDir, ".env"), "DOMAIN=example.com\n")
    // traefik, which open-webui requires, is on the server already.
    await Deno.writeTextFile(
      join(serverDir, "config.json"),
      JSON.stringify({ stacks: [{ name: "traefik" }] }),
    )
    await stackAdd("open-webui", "test", {
      cwd: dir,
      nonInteractive: true,
      // No registry is asked: the image tags stay unpinned.
      fetch: () => Promise.reject(new Error("offline")),
    })
    const env = new Map((await readEnvFile(join(serverDir, ".env"))).map((e) => [e.key, e.value]))
    assertEquals(env.get("OPEN_WEBUI_DOMAIN"), "ai.example.com")
    assertEquals(env.has("OPEN_WEBUI_OPENAI_API_KEYS"), false)
    assertEquals(env.get("OPEN_WEBUI_ENABLE_RAG_LOCAL_WEB_FETCH"), "false")
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})
