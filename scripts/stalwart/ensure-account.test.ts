import { assertEquals, assertRejects, assertThrows } from "@std/assert"

import type { Options as SieveOptions } from "./apply-sieve-filters.ts"
import {
  ensureAccount,
  installRedirect,
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

const TARGET = {
  server: "mail.example.com",
  address: "hello@example.com",
  password: PASSWORD,
  id: "e",
  redirect: "jane@example.com",
}

/** An account JMAP that answers SieveScript/get with `scripts`. */
function accountWith(scripts: Array<{ name: string; isActive: boolean }>): Jmap {
  return () => Promise.resolve({ methodResponses: [["SieveScript/get", { list: scripts }, "0"]] })
}

Deno.test("installs the redirect as the account itself, moving no mail", async () => {
  const seen: SieveOptions[] = []
  let script = ""
  await installRedirect(
    {
      accountJmap: accountWith([]),
      apply: async (opts) => {
        seen.push(opts)
        script = await Deno.readTextFile(opts.sievePath)
      },
    },
    TARGET,
  )
  assertEquals(seen.length, 1)
  assertEquals(seen[0].user, "hello@example.com")
  assertEquals(seen[0].accountId, "e")
  assertEquals(seen[0].scriptName, "redirect")
  assertEquals(seen[0].skipMove, true)
  assertEquals(seen[0].skipDeleteBounces, true)
  assertEquals(seen[0].apiUrl, "https://mail.example.com/jmap/")
  assertEquals(script.includes(`redirect "jane@example.com";`), true)
})

Deno.test("replaces its own earlier redirect script", async () => {
  let applied = 0
  await installRedirect(
    {
      accountJmap: accountWith([{ name: "redirect", isActive: true }]),
      apply: () => {
        applied++
        return Promise.resolve()
      },
    },
    TARGET,
  )
  assertEquals(applied, 1)
})

Deno.test("refuses to overwrite another active Sieve script", async () => {
  let applied = 0
  await assertRejects(
    () =>
      installRedirect(
        {
          accountJmap: accountWith([{ name: "filters", isActive: true }]),
          apply: () => {
            applied++
            return Promise.resolve()
          },
        },
        TARGET,
      ),
    Error,
    "filters",
  )
  assertEquals(applied, 0)
})
