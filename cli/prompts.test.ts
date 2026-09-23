// Tests for cli/prompts.ts — the shared strict-default resolution
// (docs/design/v1-cli.md §3.4) used by server-create and stack-add.

import { assertEquals, assertRejects } from "@std/assert"
import { UserError } from "./errors.ts"
import { promptValue } from "./prompts.ts"

Deno.test("promptValue: a provided value always wins, even non-interactively", async () => {
  const v = await promptValue({ key: "DOMAIN", label: "Domain?", provided: "example.com" })
  assertEquals(v, "example.com")
})

Deno.test("promptValue: non-interactive with a fallback returns the fallback", async () => {
  const v = await promptValue({
    key: "PUID",
    label: "PUID?",
    fallback: "1000",
    nonInteractive: true,
  })
  assertEquals(v, "1000")
})

Deno.test("promptValue: non-interactive with neither provided nor fallback throws UserError naming --var", async () => {
  await assertRejects(
    () => promptValue({ key: "CONTACT_EMAIL", label: "Email?", nonInteractive: true }),
    UserError,
    "missing CONTACT_EMAIL: pass --var CONTACT_EMAIL=",
  )
})
