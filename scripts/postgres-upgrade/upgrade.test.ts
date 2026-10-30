// Tests the parts of upgrade.sh that run before it calls docker (#363).

import { assertEquals, assertStringIncludes } from "@std/assert"

const SCRIPT = new URL("./upgrade.sh", import.meta.url).pathname

Deno.test("upgrade.sh: a rerun after an interrupted restore refuses, not 'already upgraded'", async () => {
  const root = await Deno.makeTempDir()
  try {
    await Deno.mkdir(`${root}/gitea/postgres/18/docker`, { recursive: true })
    await Deno.writeTextFile(
      `${root}/gitea/postgres/.upgrade-incomplete`,
      `${root}/gitea/db-pg16-20261030-120000\n`,
    )
    // An empty PATH: a run that got past the marker check would fail on docker, not pass.
    const out = await new Deno.Command("/bin/sh", {
      args: [SCRIPT, root, "gitea"],
      env: { PATH: "" },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output()
    const all = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr)
    assertEquals(out.code, 1, all)
    assertStringIncludes(all, "an earlier run did not finish")
    assertStringIncludes(all, `${root}/gitea/db-pg16-20261030-120000`)
    assertEquals(all.includes("already upgraded"), false, all)
  } finally {
    await Deno.remove(root, { recursive: true })
  }
})
