import { assertEquals, assertRejects, assertThrows } from "@std/assert"

import {
  ensureAccount,
  type Jmap,
  type JmapCall,
  parseArgs,
  redirectSieve,
} from "./ensure-account.ts"

const PASSWORD = "x".repeat(32)

/** A fake Stalwart with one domain and the given accounts; records each call. */
function fakeStalwart(accounts: Array<{ id: string; emailAddress: string }>) {
  const calls: JmapCall[] = []
  const jmap: Jmap = (call) => {
    calls.push(call)
    const [method] = call.methodCalls[0]
    if (method === "x:Domain/get") {
      return Promise.resolve({
        methodResponses: [
          ["x:Domain/get", { list: [{ id: "b", name: "example.com" }] }, "0"],
          ["x:Account/get", { list: accounts }, "1"],
        ],
      })
    }
    return Promise.resolve({
      methodResponses: [["x:Account/set", { created: { new: { id: "z" } } }, "0"]],
    })
  }
  return { jmap, calls }
}

Deno.test("creates the account in the address's domain when it is missing", async () => {
  const { jmap, calls } = fakeStalwart([{ id: "a", emailAddress: "jane@example.com" }])
  const result = await ensureAccount(
    jmap,
    { address: "hello@example.com", description: "Jane Doe" },
    PASSWORD,
  )
  assertEquals(result, { id: "z", created: true })
  const create = (calls[1].methodCalls[0][1].create as Record<string, Record<string, unknown>>).new
  assertEquals(create.name, "hello")
  assertEquals(create.domainId, "b")
  assertEquals(create.description, "Jane Doe")
  assertEquals(create.roles, { "@type": "User" })
})

Deno.test("leaves an existing account alone, password included", async () => {
  const { jmap, calls } = fakeStalwart([{ id: "h", emailAddress: "hello@example.com" }])
  const result = await ensureAccount(
    jmap,
    { address: "hello@example.com", description: "Jane Doe" },
    PASSWORD,
  )
  assertEquals(result, { id: "h", created: false })
  assertEquals(calls.length, 1)
})

Deno.test("refuses a domain the server does not host", async () => {
  const { jmap } = fakeStalwart([])
  await assertRejects(
    () => ensureAccount(jmap, { address: "hello@other.org", description: "J" }, PASSWORD),
    Error,
    "not configured",
  )
})

Deno.test("refuses a short password before calling the server", async () => {
  const { jmap, calls } = fakeStalwart([])
  await assertRejects(
    () => ensureAccount(jmap, { address: "hello@example.com", description: "J" }, "short"),
    Error,
    "24+",
  )
  assertEquals(calls.length, 0)
})

Deno.test("parses the options and rejects a redirect to the same address", () => {
  const base = [
    "--server",
    "mail.example.com",
    "--address",
    "hello@example.com",
    "--description",
    "Jane Doe",
    "--password-env",
    "PW",
  ]
  assertEquals(parseArgs([...base, "--redirect", "jane@example.com"]).redirect, "jane@example.com")
  assertThrows(() => parseArgs([...base, "--redirect", "hello@example.com"]), Error, "differ")
  assertThrows(() => parseArgs(base.slice(2)), Error, "--server")
})

Deno.test("the redirect script forwards to the target and refuses an injected one", () => {
  assertEquals(
    redirectSieve("jane@example.com").split("\n")[1],
    `redirect "jane@example.com";`,
  )
  assertThrows(() => redirectSieve(`jane@example.com"; discard; "`), Error)
})
