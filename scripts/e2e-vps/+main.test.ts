import { assertEquals, assertMatch, assertRejects, assertThrows } from "@std/assert"
import { type Call, LABEL, type Labelled } from "./hetzner.ts"
import { parseTarget, run, runIdFrom } from "./+main.ts"

Deno.test("reads `local` as this checkout and a version as JSR", () => {
  assertEquals(parseTarget(["local"]), { kind: "local" })
  assertEquals(parseTarget(["1.11.0"]), { kind: "jsr", version: "1.11.0" })
})

Deno.test("rejects a missing, unknown or extra argument with the usage text", () => {
  for (const args of [[], ["latest"], ["v1.11.0"], ["1.11"], ["local", "1.11.0"]]) {
    assertThrows(() => parseTarget(args), Error, "usage: deno task e2e:vps local | <version>")
  }
})

Deno.test("the run id is the start time, valid as a label value and in a hostname", () => {
  const id = runIdFrom(new Date("2026-10-13T09:05:07.123Z"))
  assertEquals(id, "20261013t090507z")
  assertMatch(id, /^[a-z0-9]+$/)
})

/** A fake Hetzner API that holds servers and SSH keys and forgets the ones it is told to delete. */
function fakeAccount(objects: Record<"servers" | "ssh_keys", Labelled[]>) {
  const deleted: string[] = []
  const call: Call = (method, path) => {
    const [kind, rest] = path.slice(1).split(/[/?]/) as ["servers" | "ssh_keys", string]
    if (method === "DELETE") {
      deleted.push(path)
      objects[kind] = objects[kind].filter((o) => String(o.id) !== rest)
      return Promise.resolve({})
    }
    return Promise.resolve({ [kind]: objects[kind], meta: { pagination: { next_page: null } } })
  }
  return { call, deleted }
}

for (const sig of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  Deno.test(`${sig} stops the run and still deletes its server, key and folder`, async () => {
    const runId = "20261013t090507z"
    const own: Labelled = {
      id: 7,
      name: `rostok-e2e-${runId}`,
      created: new Date().toISOString(),
      labels: { [LABEL]: runId },
    }
    const account = fakeAccount({ servers: [own], ssh_keys: [{ ...own, id: 8 }] })
    const dir = await Deno.makeTempDir({ prefix: "rostok-e2e-test-" })
    const handlers = new Map<string, () => void>()
    // After SIGHUP the terminal is gone and every write to it fails with an I/O error.
    const realLog = console.log
    console.log = () => {
      throw new Error("Input/output error (os error 5)")
    }
    let code: number
    let stoppedBy = ""
    try {
      code = await run(
        {
          call: account.call,
          runId,
          dir,
          start: Date.now(),
          env: {},
          onSignal: (s, handler) => handlers.set(s, handler),
        },
        (ctx) =>
          new Promise((_, reject) => {
            ctx.signal.addEventListener("abort", () => {
              stoppedBy = ctx.signal.reason.message
              reject(ctx.signal.reason)
            })
            handlers.get(sig)!()
          }),
      )
    } finally {
      console.log = realLog
    }
    assertEquals(stoppedBy, `interrupted by ${sig}`)
    assertEquals(code, 1)
    assertEquals(account.deleted, ["/servers/7", "/ssh_keys/8"])
    await assertRejects(() => Deno.stat(dir), Deno.errors.NotFound)
  })
}
