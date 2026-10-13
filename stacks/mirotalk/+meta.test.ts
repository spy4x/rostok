// mirotalk-specific checks. The checks every +meta.ts shares live in stacks/meta.test.ts.

import { assert, assertEquals, assertRejects } from "@std/assert"
import { renderCompose } from "../compose-interpolate.ts"
import meta from "./+meta.ts"

/** MiroTalk's own minimum: it exits at start with a shorter JWT_KEY (spy4x/rostok#373). */
const UPSTREAM_MIN_KEY_LENGTH = 32

/** Every value the compose file requires; a test removes or blanks the one it is about. */
const ENV = {
  DOMAIN: "example.com",
  MIROTALK_JWT_KEY: "k".repeat(UPSTREAM_MIN_KEY_LENGTH),
  MIROTALK_API_KEY_SECRET: "api-key-of-this-server",
  MIROTALK_TURN_SERVER_USERNAME: "turn-user",
  MIROTALK_TURN_SERVER_CREDENTIAL: "turn-credential",
  MIROTALK_PUBLIC_IP: "198.51.100.7",
}

/** `ENV` with one key left out, and with that key blank. */
function withoutValue(key: keyof typeof ENV): Record<string, string>[] {
  const { [key]: _, ...missing } = ENV
  return [missing, { ...ENV, [key]: "" }]
}

Deno.test("mirotalk compose: the container gets MIROTALK_JWT_KEY as JWT_KEY", async () => {
  const rendered = await renderCompose("mirotalk", ENV)
  assertEquals(rendered.match(/^ +- JWT_KEY=.*$/gm), [`      - JWT_KEY=${ENV.MIROTALK_JWT_KEY}`])
})

Deno.test("mirotalk compose: an .env with no or a blank MIROTALK_JWT_KEY does not render", async () => {
  // Compose refuses a `${KEY:?}` without a value, so the deploy stops before the container
  // starts and restarts forever.
  for (const env of withoutValue("MIROTALK_JWT_KEY")) {
    await assertRejects(
      () => renderCompose("mirotalk", env),
      Error,
      "required variable MIROTALK_JWT_KEY is missing a value",
    )
  }
})

Deno.test("mirotalk +meta.ts: the JWT key is a required secret, generated long enough to start", () => {
  const spec = meta.variables.find((v) => v.key === "MIROTALK_JWT_KEY")
  assert(spec, "+meta.ts does not declare MIROTALK_JWT_KEY")
  assertEquals(spec.required, true)
  assertEquals(spec.secret, true)
  assertEquals(typeof spec.default, "function")
  const key = (spec.default as () => string)()
  assert(
    key.length >= UPSTREAM_MIN_KEY_LENGTH,
    `generated key has ${key.length} characters, MiroTalk needs ${UPSTREAM_MIN_KEY_LENGTH}`,
  )
  assert(/^[A-Za-z0-9_-]+$/.test(key), "generated key must need no quoting in .env")
})

Deno.test("mirotalk compose: the container gets MIROTALK_API_KEY_SECRET as API_KEY_SECRET", async () => {
  // Without API_KEY_SECRET the image falls back to a key printed in MiroTalk's documentation, and
  // its API answers to anyone who read it (spy4x/rostok#379).
  const rendered = await renderCompose("mirotalk", ENV)
  assertEquals(rendered.match(/^ +- API_KEY_SECRET=.*$/gm), [
    `      - API_KEY_SECRET=${ENV.MIROTALK_API_KEY_SECRET}`,
  ])
})

Deno.test("mirotalk compose: an .env with no or a blank MIROTALK_API_KEY_SECRET does not render", async () => {
  for (const env of withoutValue("MIROTALK_API_KEY_SECRET")) {
    await assertRejects(
      () => renderCompose("mirotalk", env),
      Error,
      "required variable MIROTALK_API_KEY_SECRET is missing a value",
    )
  }
})

Deno.test("mirotalk +meta.ts: the API key is a required secret, generated", () => {
  const spec = meta.variables.find((v) => v.key === "MIROTALK_API_KEY_SECRET")
  assert(spec, "+meta.ts does not declare MIROTALK_API_KEY_SECRET")
  assertEquals(spec.required, true)
  assertEquals(spec.secret, true)
  assertEquals(typeof spec.default, "function")
  const generate = spec.default as () => string
  const key = generate()
  assert(key.length >= 32, `generated key has ${key.length} characters, too few to resist guessing`)
  assert(/^[A-Za-z0-9_-]+$/.test(key), "generated key must need no quoting in .env")
  assert(key !== generate(), "two calls gave the same key, so it is not generated per server")
})

Deno.test("mirotalk compose: MiroTalk and coturn get the same TURN username and credential", async () => {
  const rendered = await renderCompose("mirotalk", ENV)
  assert(rendered.includes("      - TURN_SERVER_USERNAME=turn-user\n"))
  assert(rendered.includes("      - TURN_SERVER_CREDENTIAL=turn-credential\n"))
  assert(rendered.includes("      - --user=turn-user:turn-credential\n"))
})

for (const key of ["MIROTALK_TURN_SERVER_USERNAME", "MIROTALK_TURN_SERVER_CREDENTIAL"] as const) {
  Deno.test(`mirotalk compose: an .env with no or a blank ${key} does not render`, async () => {
    // An empty value used to render: MiroTalk then offered a TURN server nobody can log in to.
    for (const env of withoutValue(key)) {
      await assertRejects(
        () => renderCompose("mirotalk", env),
        Error,
        `required variable ${key} is missing a value`,
      )
    }
  })
}

/** An IPv4 or IPv6 address as a number; an IPv4 address gets its IPv4-mapped IPv6 value. */
function addressValue(address: string): bigint {
  const v4 = address.match(/^(.*:)?(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (v4) {
    const [hi, lo] = [(+v4[2] << 8) | +v4[3], (+v4[4] << 8) | +v4[5]]
    address = `${v4[1] ?? "::ffff:"}${hi.toString(16)}:${lo.toString(16)}`
  }
  const [head, tail] = address.split("::").map((part) => part ? part.split(":") : [])
  const groups = tail === undefined
    ? head
    : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]
  assertEquals(groups.length, 8, `not an IP address: ${address}`)
  return groups.reduce((sum, group) => (sum << 16n) | BigInt(parseInt(group, 16)), 0n)
}

/** Whether the rendered coturn command refuses `peer`, by a denied range or the multicast flag. */
function relayRefuses(rendered: string, peer: string): boolean {
  const multicast = /^(22[4-9]|23\d)\.|^ff/i.test(peer)
  if (multicast && rendered.includes("      - --no-multicast-peers\n")) return true
  const value = addressValue(peer)
  const family = peer.includes(":")
  return [...rendered.matchAll(/^ +- --denied-peer-ip=(.+)$/gm)].some((match) => {
    const [first, last = first] = match[1].split("-")
    // coturn 4.18 takes a range that starts at `::` as one that holds every peer of both families.
    if (first.includes(":") && addressValue(first) === 0n) return true
    return first.includes(":") === family && addressValue(first) <= value &&
      value <= addressValue(last)
  })
}

Deno.test("mirotalk compose: the coturn command denies every peer range that is not public", async () => {
  // Every joiner of a room gets the TURN login, and coturn runs on the host's own network: without
  // these ranges a stranger reaches the Docker networks and the private network through the relay
  // (spy4x/rostok#409).
  const rendered = await renderCompose("mirotalk", ENV)
  const notPublic = [
    ...["0.0.0.0", "0.255.255.255", "10.0.0.0", "10.255.255.255", "100.64.0.0", "100.127.255.255"],
    ...["127.0.0.1", "127.255.255.255", "169.254.169.254", "172.16.0.0", "172.31.255.255"],
    ...["192.168.0.0", "192.168.255.255", "224.0.0.1", "239.255.255.255"],
    ...["192.0.0.0", "192.0.0.255", "198.18.0.0", "198.19.255.255"],
    ...["::1", "fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe80::"],
    ...["febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "ff02::1", "::ffff:10.0.0.1"],
  ]
  assertEquals(notPublic.filter((peer) => !relayRefuses(rendered, peer)), [])
})

Deno.test("mirotalk compose: the coturn command denies no public peer, nor the server's own address", async () => {
  // Two browsers that both need the relay talk from one relay address to the other, and both are
  // the server's public address: refusing it would end every such call.
  const rendered = await renderCompose("mirotalk", ENV)
  // The IPv4 samples are the ones stacks/neutral-examples.test.ts lets a catalog file name.
  const isPublic = [
    ...[ENV.MIROTALK_PUBLIC_IP, "1.1.1.1", "8.8.8.8", "9.9.9.9", "192.0.2.1", "203.0.113.1"],
    ...["2001:4860:4860::8888", "fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe00::", "fec0::"],
  ]
  assertEquals(isPublic.filter((peer) => relayRefuses(rendered, peer)), [])
})
