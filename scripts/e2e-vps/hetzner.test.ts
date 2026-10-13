import { assertEquals, assertRejects, assertThrows } from "@std/assert"
import {
  cheapestX86,
  createCall,
  createKey,
  createServer,
  deleteLabelled,
  deleteOne,
  type Labelled,
  listLabelled,
  ofRun,
  olderThanStale,
  STALE_MS,
  tokenFromEnv,
} from "./hetzner.ts"

const TOKEN = "test-token-not-a-real-one"
const NOW = Date.parse("2026-10-13T12:00:00Z")
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

/** The owner's long-lived test server: no label, so nothing may ever delete it. */
const UNLABELLED: Labelled = {
  id: 1,
  name: "rostok-cli-v1-test",
  created: minutesAgo(60 * 24 * 30),
  labels: {},
}
const OWN: Labelled = {
  id: 2,
  name: "rostok-e2e-own",
  created: minutesAgo(5),
  labels: { "rostok-e2e": "own" },
}
const OTHER_YOUNG: Labelled = {
  id: 3,
  name: "rostok-e2e-other",
  created: minutesAgo(30),
  labels: { "rostok-e2e": "other" },
}
const OTHER_STALE: Labelled = {
  id: 4,
  name: "rostok-e2e-killed",
  created: minutesAgo(121),
  labels: { "rostok-e2e": "killed" },
}

interface Sent {
  method: string
  url: string
  headers: Record<string, string>
  body: string | undefined
}

/**
 * A fake API that ignores the label selector, as a broken or changed API would: every list
 * returns every object it was given, labelled or not.
 */
function fakeApi(objects: Labelled[], pageSize = 50) {
  const sent: Sent[] = []
  const fetchFn = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? "GET"
    sent.push({
      method,
      url: url.href,
      headers: init?.headers as Record<string, string>,
      body: init?.body as string | undefined,
    })
    const kind = url.pathname.split("/")[2]
    let json: unknown = {}
    if (method === "GET") {
      const page = Number(url.searchParams.get("page") ?? "1")
      const slice = objects.slice((page - 1) * pageSize, page * pageSize)
      const next = page * pageSize < objects.length ? page + 1 : null
      json = { [kind]: slice, meta: { pagination: { next_page: next } } }
    }
    return Promise.resolve(new Response(JSON.stringify(json), { status: 200 }))
  }
  const deleted = () =>
    sent.filter((s) => s.method === "DELETE").map((s) => new URL(s.url).pathname)
  return { call: createCall(TOKEN, fetchFn as typeof fetch), sent, deleted }
}

Deno.test("never deletes a server without the label, even when the API returns it", async () => {
  const api = fakeApi([UNLABELLED, OWN, OTHER_STALE])
  const names = await deleteLabelled(api.call, "servers", () => true)
  assertEquals(names, ["rostok-e2e-own", "rostok-e2e-killed"])
  assertEquals(api.deleted(), ["/v1/servers/2", "/v1/servers/4"])
})

Deno.test("never deletes an SSH key without the label", async () => {
  const api = fakeApi([{ ...UNLABELLED, name: "owner-laptop" }, OWN])
  await deleteLabelled(api.call, "ssh_keys", () => true)
  assertEquals(api.deleted(), ["/v1/ssh_keys/2"])
})

Deno.test("refuses to send a DELETE for an object without the label", async () => {
  const api = fakeApi([])
  await assertRejects(
    () => deleteOne(api.call, "servers", UNLABELLED),
    Error,
    'refusing to delete servers "rostok-cli-v1-test"',
  )
  await assertRejects(() => deleteOne(api.call, "servers", { ...UNLABELLED, labels: undefined }))
  await assertRejects(
    () => deleteOne(api.call, "servers", { ...UNLABELLED, labels: { other: "rostok-e2e" } }),
  )
  assertEquals(api.sent, [])
})

Deno.test("asks the API for the label when it lists servers and keys", async () => {
  const api = fakeApi([OWN])
  await listLabelled(api.call, "servers")
  await listLabelled(api.call, "ssh_keys")
  assertEquals(api.sent.map((s) => s.url), [
    "https://api.hetzner.cloud/v1/servers?label_selector=rostok-e2e&per_page=50&page=1",
    "https://api.hetzner.cloud/v1/ssh_keys?label_selector=rostok-e2e&per_page=50&page=1",
  ])
})

Deno.test("lists labelled objects from every page", async () => {
  const api = fakeApi([OWN, UNLABELLED, OTHER_YOUNG, OTHER_STALE], 2)
  const names = (await listLabelled(api.call, "servers")).map((o) => o.name)
  assertEquals(names, ["rostok-e2e-own", "rostok-e2e-other", "rostok-e2e-killed"])
})

Deno.test("the run's own cleanup leaves other runs' servers alone", async () => {
  const api = fakeApi([UNLABELLED, OWN, OTHER_YOUNG, OTHER_STALE])
  await deleteLabelled(api.call, "servers", ofRun("own"))
  assertEquals(api.deleted(), ["/v1/servers/2"])
})

Deno.test("the stale sweep deletes labelled servers older than two hours only", async () => {
  const api = fakeApi([UNLABELLED, OWN, OTHER_YOUNG, OTHER_STALE])
  await deleteLabelled(api.call, "servers", olderThanStale(NOW))
  assertEquals(api.deleted(), ["/v1/servers/4"])
})

Deno.test("a server exactly two hours old is not stale yet", () => {
  const atLimit = { ...OWN, created: new Date(NOW - STALE_MS).toISOString() }
  const pastLimit = { ...OWN, created: new Date(NOW - STALE_MS - 1).toISOString() }
  assertEquals(olderThanStale(NOW)(atLimit), false)
  assertEquals(olderThanStale(NOW)(pastLimit), true)
})

Deno.test("sends the token in the Authorization header and nowhere else", async () => {
  const api = fakeApi([])
  await api.call("POST", "/ssh_keys", { name: "rostok-e2e-run1" })
  const [request] = api.sent
  assertEquals(request.headers.Authorization, `Bearer ${TOKEN}`)
  assertEquals(request.url.includes(TOKEN), false)
  assertEquals(request.body?.includes(TOKEN), false)
})

Deno.test("an API error names the call and the API's reason, never the token", async () => {
  const fetchFn = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ error: { code: "resource_unavailable", message: "out of stock" } }),
        { status: 412 },
      ),
    )
  const call = createCall(TOKEN, fetchFn as typeof fetch)
  const err = await assertRejects(() => call("POST", "/servers", {}), Error)
  assertEquals(err.message, "Hetzner API POST /servers: 412 resource_unavailable out of stock")
})

Deno.test("labels the key and the server it creates with the run id", async () => {
  const fetchFn = (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(init?.body as string))
    return Promise.resolve(
      new Response(JSON.stringify({ ssh_key: { id: 7 }, server: { id: 8 } }), { status: 201 }),
    )
  }
  // deno-lint-ignore no-explicit-any
  const bodies: any[] = []
  const call = createCall(TOKEN, fetchFn as typeof fetch)
  const keyId = await createKey(call, "run1", "ssh-ed25519 AAAA")
  await createServer(call, "run1", { type: "cx23", location: "hel1", hourly: 0.005 }, keyId, "#x")
  assertEquals(bodies[0].labels, { "rostok-e2e": "run1" })
  assertEquals(bodies[1].labels, { "rostok-e2e": "run1" })
  assertEquals(bodies[1].name, "rostok-e2e-run1")
  assertEquals(bodies[1].ssh_keys, [7])
  assertEquals([bodies[1].server_type, bodies[1].location], ["cx23", "hel1"])
})

Deno.test("offers the cheapest x86 type first and skips arm and deprecated types", async () => {
  const price = (location: string, net: string) => ({ location, price_hourly: { net } })
  const fetchFn = () =>
    Promise.resolve(
      new Response(JSON.stringify({
        server_types: [
          { name: "cpx11", architecture: "x86", prices: [price("fsn1", "0.0070")] },
          { name: "cax11", architecture: "arm", prices: [price("fsn1", "0.0010")] },
          {
            name: "cx11",
            architecture: "x86",
            deprecation: { announced: "2024-01-01T00:00:00Z" },
            prices: [price("fsn1", "0.0020")],
          },
          {
            name: "cx23",
            architecture: "x86",
            deprecation: null,
            prices: [price("nbg1", "0.0060"), price("hel1", "0.0050")],
          },
        ],
      })),
    )
  const offers = await cheapestX86(createCall(TOKEN, fetchFn as typeof fetch))
  assertEquals(offers.map((o) => `${o.type}@${o.location}`), [
    "cx23@hel1",
    "cx23@nbg1",
    "cpx11@fsn1",
  ])
})

Deno.test("fails with a clear message when the token is missing or empty", () => {
  assertThrows(() => tokenFromEnv(() => undefined), Error, "HETZNER_CLOUD_API_TOKEN is not set")
  assertThrows(() => tokenFromEnv(() => "  "), Error, "HETZNER_CLOUD_API_TOKEN is not set")
  assertEquals(
    tokenFromEnv((key) => key === "HETZNER_CLOUD_API_TOKEN" ? "abc\n" : undefined),
    "abc",
  )
})
