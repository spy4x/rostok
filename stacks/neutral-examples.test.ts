// Keeps one installation's setup out of the shipped catalog (spy4x/rostok#341): every file under
// `stacks/` and `cli/` that git tracks, or would track, may name only example hosts, addresses
// and IPs. The catalog travels to every user through JSR, so a real domain, mailbox or server IP
// in it is both a leak and a misconfiguration on someone else's server.
//
// Three rules, none of which needs a private list:
//   - E-mail addresses must be at a reserved example domain (RFC 2606 / RFC 6761).
//   - IPv4 addresses must be private, loopback, link-local, reserved, documentation (RFC 5737) or one of
//     the public DNS resolvers named below. This is the rule that guards a server's real IP,
//     without the check having to publish it.
//   - The author's public names (already on the README and the GitHub profile) may appear only
//     as a registry or repository namespace, such as an image `<name>/<image>` or a link.
// IPv6 addresses are not checked.

import { assert, assertEquals } from "@std/assert"
import { fromFileUrl, join } from "@std/path"

const repoRoot = fromFileUrl(new URL("../", import.meta.url))
const SELF = "stacks/neutral-examples.test.ts"

/** Names of the catalog's author. Allowed only right before `/`: a public namespace. */
const AUTHOR_NAMES = /(antonshubin|neatsoft|spy4x)(?!\/)/gi
/** The one env key that carried such a name. The stalwart hook still names it, to refuse it. */
const RETIRED_KEY = /STALWART_NEATSOFT_DOMAIN/g

const EMAIL = /[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g
const EXAMPLE_DOMAIN = /(^|\.)(example\.(com|net|org)|test|example|invalid|localhost)$/i

// An octet may be the letter x, so a masked address ("198.51.x.x") is judged by its first octets.
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3}|x)\.(\d{1,3}|x)(?!\.?\d)/g
/** Public resolvers a stack may name as an upstream. */
const PUBLIC_RESOLVERS = new Set(["1.1.1.1", "8.8.8.8", "9.9.9.9"])

/** Whether an IPv4 address belongs to nobody's server: reserved, private or documentation. */
export function isNeutralIpv4(a: number, b: number, c: number): boolean {
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
}

/** What a file's text holds that is not a neutral example, as `line N: reason` strings. */
export function findLeftovers(text: string): string[] {
  const found: string[] = []
  text.split("\n").forEach((line, index) => {
    const at = `line ${index + 1}`
    for (const m of line.replace(RETIRED_KEY, "").matchAll(AUTHOR_NAMES)) {
      found.push(`${at}: "${m[1]}" is the catalog author's own name; use a neutral example`)
    }
    for (const m of line.matchAll(EMAIL)) {
      if (!EXAMPLE_DOMAIN.test(m[1])) {
        found.push(`${at}: e-mail address ${m[0]} is not at an example domain (example.com)`)
      }
    }
    for (const m of line.matchAll(IPV4)) {
      const octets = [m[1], m[2], m[3]].map((o) => o === "x" ? 0 : Number(o))
      // Not an address at all: a version or section number with a part above 255.
      if (octets.some((o) => o > 255) || Number(m[4]) > 255) continue
      if (PUBLIC_RESOLVERS.has(m[0]) || isNeutralIpv4(octets[0], octets[1], octets[2])) continue
      found.push(`${at}: IPv4 address ${m[0]} is public; use an RFC 5737 one (192.0.2.1)`)
    }
  })
  return found
}

/** Every file under `stacks/` and `cli/` that git tracks or would track, relative to the repo. */
async function catalogFiles(): Promise<string[]> {
  const out = await new Deno.Command("git", {
    args: ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "stacks", "cli"],
    cwd: repoRoot,
    stdout: "piped",
    stderr: "piped",
  }).output()
  assertEquals(out.code, 0, `git ls-files failed: ${new TextDecoder().decode(out.stderr)}`)
  return new TextDecoder().decode(out.stdout).split("\0").filter((path) => path !== "")
}

Deno.test("stacks/ and cli/ hold no real domain, e-mail address or server IP", async () => {
  const files = await catalogFiles()
  const violations: string[] = []
  let scanned = 0
  for (const path of files) {
    if (path === SELF) continue
    let text: string
    try {
      text = await Deno.readTextFile(join(repoRoot, path))
    } catch (err) {
      // Deleted in the working tree but not committed yet: nothing to ship.
      if (err instanceof Deno.errors.NotFound) continue
      throw err
    }
    scanned++
    for (const leftover of findLeftovers(text)) violations.push(`${path} ${leftover}`)
  }
  // A listing that came back nearly empty would pass without having looked at anything.
  assert(scanned > 300, `scanned only ${scanned} files: is the git listing broken?`)
  assertEquals(violations, [])
})

Deno.test("an owner domain planted in a stack file is reported with its line", () => {
  const compose = [
    "services:",
    "  app:",
    '    - "traefik.http.routers.app.rule=Host(`webmail.antonshubin.com`)"',
  ].join("\n")
  assertEquals(findLeftovers(compose), [
    `line 3: "antonshubin" is the catalog author's own name; use a neutral example`,
  ])
  assertEquals(findLeftovers("see https://NeatSoft.dev").length, 1)
  assertEquals(findLeftovers("users:\n  spy4x:\n").length, 1)
  assertEquals(findLeftovers("STALWART_NEATSOFT_DOMAIN is no longer read"), [])
})

Deno.test("the author's name as an image or repository namespace is allowed", () => {
  assertEquals(findLeftovers("image: antonshubin/mig:latest"), [])
  assertEquals(findLeftovers("image: ghcr.io/spy4x/oko:latest (spy4x/rostok#341)"), [])
  assertEquals(findLeftovers('import { x } from "@spy4x/server/env-age64"'), [])
})

Deno.test("an e-mail address outside the example domains is reported", () => {
  assertEquals(findLeftovers("email: someone@gmail.com").length, 1)
  assertEquals(findLeftovers("from: noreply@mail.example-shop.com").length, 1)
  assertEquals(
    findLeftovers("a@example.com b@mail.example.org c@remote.test root@192.0.2.1 d@host.invalid"),
    [],
  )
  // A package version is no address: nothing after the @ is a domain name.
  assertEquals(findLeftovers('import "npm:bcryptjs@3.0.3" // jsr:@std/yaml@1.0.5'), [])
})

Deno.test("a public IPv4 address is reported, also when its last octets are masked", () => {
  assertEquals(findLeftovers("ssh root@198.20.0.1").length, 1)
  assertEquals(findLeftovers("the cloud server (203.1.x.x)").length, 1)
  assertEquals(findLeftovers("addresses: tcp://45.67.89.10:22000").length, 1)
})

Deno.test("private, loopback, documentation and resolver IPv4 addresses are allowed", () => {
  const neutral = [
    "0.0.0.0",
    "10.1.2.3",
    "127.0.0.11",
    "100.64.0.1",
    "169.254.169.254",
    "172.18.0.0/16",
    "192.168.1.10",
    "192.0.0.8",
    "192.0.2.1",
    "198.18.0.1",
    "198.19.255.254",
    "198.51.100.7",
    "203.0.113.9",
    "255.255.255.0",
    "1.1.1.1",
    "8.8.8.8",
    "9.9.9.9",
  ]
  assertEquals(findLeftovers(neutral.join(" ")), [])
  // Neighbours of the allowed ranges are public.
  assertEquals(
    findLeftovers("172.32.0.1 192.0.1.1 192.0.3.1 100.128.0.1 198.17.0.1 198.20.0.1 198.51.101.1")
      .length,
    7,
  )
  // A version with a part above 255 is not an address.
  assertEquals(findLeftovers("tag 1.300.2.1, section 1.2.3.300"), [])
})
