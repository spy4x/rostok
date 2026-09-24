// Tests for cli/errors.ts.

import { assertEquals, assertRejects } from "@std/assert"
import { join } from "@std/path"
import { serverNotFoundMessage, UserError } from "./errors.ts"
import { runDeploy } from "./deploy/run-deploy.ts"

Deno.test("serverNotFoundMessage: exact wording", () => {
  assertEquals(
    serverNotFoundMessage("home", "/tmp/x/servers/home/.env"),
    "server 'home' not found at /tmp/x/servers/home/.env. Run `rostok server create home` first.",
  )
})

// #236 — cli/deploy/run-deploy.ts:108 keeps its own copy of this exact
// string, rather than calling serverNotFoundMessage(), until it's
// switched over. This is a BEHAVIOR test, not a source-text comparison:
// it runs the real runDeploy() against a fresh temp dir with no
// servers/ghost/.env, which throws before any ssh/rsync/network access
// (see run-deploy.ts's own #208 comment), and checks the thrown
// message against serverNotFoundMessage()'s output. That way, once
// run-deploy.ts is switched to call the helper directly, this test
// keeps passing instead of going red on a correct refactor (a
// source-text version of this test did exactly that).
Deno.test("serverNotFoundMessage: matches what runDeploy actually throws for a missing server", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "rostok-errors-" })
  try {
    const err = await assertRejects(
      () => runDeploy({ cwd: tmp, server: "ghost" }),
      UserError,
    )
    const envPath = join(tmp, "servers", "ghost", ".env")
    assertEquals(err.message, serverNotFoundMessage("ghost", envPath))
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {})
  }
})
