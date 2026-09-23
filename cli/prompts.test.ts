// Tests for cli/prompts.ts — the shared strict-default resolution
// (docs/design/v1-cli.md §3.4) used by server-create and stack-add.

import { assertEquals, assertRejects } from "@std/assert"
import { UserError } from "./errors.ts"
import { type PromptBase, promptValue, withKeyLabel } from "./prompts.ts"

// #212 — every interactive prompt shows its `--var` key so a hobbyist
// learns the flag to pass next time, instead of only an internal field
// name like `serverName`.
Deno.test("withKeyLabel: appends the key in parentheses", () => {
  assertEquals(
    withKeyLabel("Server name, used as a folder name", "SERVER_NAME"),
    "Server name, used as a folder name (SERVER_NAME)",
  )
})

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

// Security review — `validate` used to run only inside the interactive
// cliffy prompt, so a --var value (or a non-interactive fallback) never
// got checked at all. A caller-supplied SSH target or remote path is
// just as untrusted as something typed interactively.

const reject = () => "must be 'ok'"
const isOk = (v: string) => v === "ok" ? true : reject()

Deno.test("promptValue: validate runs against a provided (--var) value, not just interactive input", async () => {
  await assertRejects(
    () => promptValue({ key: "SSH_ADDRESS", label: "?", provided: "bad", validate: isOk }),
    UserError,
    "invalid SSH_ADDRESS: must be 'ok'",
  )
})

Deno.test("promptValue: validate runs against the non-interactive fallback", async () => {
  await assertRejects(
    () =>
      promptValue({
        key: "SSH_ADDRESS",
        label: "?",
        fallback: "bad",
        nonInteractive: true,
        validate: isOk,
      }),
    UserError,
    "invalid SSH_ADDRESS: must be 'ok'",
  )
})

// #211/#212 review — a `validate` adapted from server-keys.ts's throwing
// `validate*` functions (via server-create.ts's `toValidator`) already
// returns a message that starts with "invalid <key> ..." (it names the
// key itself). assertValid must not add a second "invalid <key>: "
// prefix on top of that one.
const rejectWithOwnPrefix = (v: string) => `invalid SSH_ADDRESS "${v}": must be 'ok'`
const selfPrefixed = (v: string) => v === "ok" ? true : rejectWithOwnPrefix(v)

Deno.test("promptValue: doesn't double the 'invalid <key>' prefix when validate already includes it", async () => {
  let message = ""
  try {
    await promptValue({ key: "SSH_ADDRESS", label: "?", provided: "bad", validate: selfPrefixed })
  } catch (err) {
    message = err instanceof Error ? err.message : String(err)
  }
  // assertRejects' msgIncludes is a substring check, which the duplicated
  // "invalid SSH_ADDRESS: invalid SSH_ADDRESS ..." form would still pass
  // (the correct message is a substring of the buggy one) — assert exact
  // equality instead so a reintroduced double prefix is caught.
  assertEquals(message, `invalid SSH_ADDRESS "bad": must be 'ok'`)
})

// Review fix — the interactive branch (no `provided`, no `nonInteractive`)
// was untestable without a real TTY, so nothing ever proved the label a
// caller builds (e.g. withKeyLabel's output) actually reaches the
// prompt the user sees. `promptFn` lets a test drive that branch.
Deno.test("promptValue: the interactive branch calls promptFn with the exact label, not the bare key", async () => {
  const seen: PromptBase[] = []
  const v = await promptValue({
    key: "SERVER_NAME",
    label: "Server name, used as a folder name (SERVER_NAME)",
    promptFn: (base) => {
      seen.push(base)
      return Promise.resolve("home")
    },
  })
  assertEquals(v, "home")
  assertEquals(seen.length, 1)
  assertEquals(seen[0].message, "Server name, used as a folder name (SERVER_NAME)")
})

Deno.test("promptValue: secret:true routes through promptFn's secret flag", async () => {
  let sawSecret: boolean | undefined
  await promptValue({
    key: "PASSWORD",
    label: "Password (PASSWORD)",
    secret: true,
    promptFn: (_base, secret) => {
      sawSecret = secret
      return Promise.resolve("hunter2")
    },
  })
  assertEquals(sawSecret, true)
})

Deno.test("promptValue: a validate that passes doesn't affect the result", async () => {
  const v = await promptValue({
    key: "SSH_ADDRESS",
    label: "?",
    provided: "ok",
    validate: isOk,
  })
  assertEquals(v, "ok")
})
