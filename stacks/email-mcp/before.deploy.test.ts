import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import { renderConfig, tomlString } from "./before.deploy.ts"

const base = {
  EMAIL_MCP_HOST: "mail.example.com",
  EMAIL_MCP_USER: "me@example.com",
  EMAIL_MCP_PASSWORD: "pw1",
}

/** The rendered lines, so a test can assert on whole lines instead of substrings. */
const linesOf = (env: Record<string, string>) => renderConfig(env).split("\n")

Deno.test("email-mcp config: one account gets IMAP 993 and SMTP 587 on the given host", () => {
  const lines = linesOf(base)
  assertEquals(lines.filter((l) => l === "[[emails]]").length, 1)
  assertEquals(lines.filter((l) => l === `host = "mail.example.com"`).length, 2)
  assertEquals(lines.filter((l) => l === "port = 993").length, 1)
  assertEquals(lines.filter((l) => l === "port = 587").length, 1)
  assert(lines.includes(`email_address = "me@example.com"`))
  assert(lines.includes(`full_name = "me@example.com"`))
})

Deno.test("email-mcp config: the second account appears only when its user is set", () => {
  const lines = linesOf({
    ...base,
    EMAIL_MCP_USER_2: "you@example.org",
    EMAIL_MCP_PASSWORD_2: "pw2",
  })
  assertEquals(lines.filter((l) => l === "[[emails]]").length, 2)
  assert(lines.includes(`email_address = "you@example.org"`))
  assertEquals(lines.filter((l) => l === `password = "pw2"`).length, 2)
})

Deno.test("email-mcp config: enable_attachment_download comes before the first table", () => {
  const lines = linesOf(base)
  const key = lines.indexOf("enable_attachment_download = false")
  assert(key >= 0, "key missing")
  assert(key < lines.indexOf("[[emails]]"), "a key after a [table] header belongs to that table")
})

Deno.test("email-mcp config: verify_ssl follows EMAIL_MCP_VERIFY_SSL", () => {
  assertEquals(linesOf(base).filter((l) => l === "verify_ssl = false").length, 2)
  const on = linesOf({ ...base, EMAIL_MCP_VERIFY_SSL: "true" })
  assertEquals(on.filter((l) => l === "verify_ssl = true").length, 2)
})

Deno.test("email-mcp config: quotes, backslashes and newlines in a password are escaped", () => {
  assertEquals(tomlString(`a"b\\c\nd`), `"a\\"b\\\\c\\u000ad"`)
  const lines = linesOf({ ...base, EMAIL_MCP_PASSWORD: `p"w\n#y` })
  assert(lines.includes(`password = "p\\"w\\u000a#y"`))
})

Deno.test("email-mcp config: names every missing required key", () => {
  const err = assertThrows(() => renderConfig({ EMAIL_MCP_HOST: "h" }), Error)
  assertStringIncludes(err.message, "EMAIL_MCP_USER, EMAIL_MCP_PASSWORD")
  const err2 = assertThrows(
    () => renderConfig({ ...base, EMAIL_MCP_USER_2: "x@example.org" }),
    Error,
  )
  assertStringIncludes(err2.message, "EMAIL_MCP_PASSWORD_2")
})
