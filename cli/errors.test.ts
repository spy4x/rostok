// Tests for cli/errors.ts.

import { assertEquals, assertStringIncludes } from "@std/assert"
import { serverNotFoundMessage } from "./errors.ts"

Deno.test("serverNotFoundMessage: exact wording", () => {
  assertEquals(
    serverNotFoundMessage("home", "/tmp/x/servers/home/.env"),
    "server 'home' not found at /tmp/x/servers/home/.env. Run `rostok server create home` first.",
  )
})

// #236 — cli/deploy/run-deploy.ts:108 (H's file, out of this module's
// ownership) has its own copy of this exact string rather than calling
// this helper. This test reads that file's source and checks the two
// stay byte-identical, so a future edit to either side gets caught here
// instead of only surfacing as "these three messages don't match" in
// production.
Deno.test("serverNotFoundMessage: matches cli/deploy/run-deploy.ts's own copy of this string", async () => {
  const runDeployPath = new URL("./deploy/run-deploy.ts", import.meta.url)
  const source = await Deno.readTextFile(runDeployPath)
  // run-deploy.ts's own template literal, exactly as it appears in
  // source (its `\`rostok server create ...\`` needs the same backslash
  // escapes a literal backtick takes inside a template literal).
  const expectedLiteral =
    "`server '${server}' not found at ${envPath}. Run \\`rostok server create ${server}\\` first.`"
  assertStringIncludes(source, expectedLiteral)
})
