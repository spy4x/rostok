// Deploy never fills a `+meta.ts` default: only `stack add` writes it, and `rostok deploy` runs
// compose with the server's `.env` as it is. A server added before a `<STACK>_DOMAIN` variable
// existed has no such key, so each compose file must fall back to the host it used before the
// variable. These tests render the compose files the way compose does, with an `.env` that lacks
// the new keys, and check the hosts that come out.

import { assert, assertEquals } from "@std/assert"

const stacksDir = new URL("./", import.meta.url)

/**
 * Interpolate `${KEY}`, `${KEY:-fallback}` and `${KEY-fallback}` like docker compose, innermost
 * reference first so a fallback may hold another reference. A key missing from `env` is empty.
 */
function interpolate(text: string, env: Record<string, string>): string {
  const ref = /\$\{([A-Z0-9_]+)(?:(:?)-([^${}]*))?\}/g
  let out = text
  for (let i = 0; i < 10 && out.includes("${"); i++) {
    out = out.replace(ref, (_m, key: string, colon: string | undefined, fallback?: string) => {
      const value = env[key]
      if (fallback === undefined) return value ?? ""
      return value === undefined || (colon === ":" && value === "") ? fallback : value
    })
  }
  assert(!out.includes("${"), `unresolved reference left in: ${out.match(/\$\{[^}]*/)}`)
  return out
}

/** A stack's compose.yml, comment lines removed, rendered with `env`. */
async function render(stack: string, env: Record<string, string>): Promise<string> {
  const raw = await Deno.readTextFile(new URL(`./${stack}/compose.yml`, stacksDir))
  const code = raw.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n")
  return interpolate(code, env)
}

const hostsOf = (rendered: string) => [...rendered.matchAll(/Host\(`([^`]*)`\)/g)].map((m) => m[1])

// What a server's .env holds without any key this wave introduced.
const OLD_ENV = { DOMAIN: "example.com", NGINX_CONTAINER_NAME: "hl-nginx" }

const CASES: { stack: string; hosts: string[]; override: string }[] = [
  { stack: "adguard", hosts: ["dns.example.com"], override: "ADGUARD_DOMAIN" },
  { stack: "healthchecks", hosts: ["healthchecks.example.com"], override: "HEALTHCHECKS_DOMAIN" },
  { stack: "mirotalk", hosts: ["talk.example.com"], override: "MIROTALK_DOMAIN" },
  { stack: "nginx", hosts: ["hl-nginx.example.com"], override: "NGINX_DOMAIN" },
  { stack: "ollama", hosts: ["ollama.example.com"], override: "OLLAMA_DOMAIN" },
  {
    stack: "umami",
    hosts: ["stats.example.com", "example.com", "www.example.com"],
    override: "UMAMI_DOMAIN",
  },
]

for (const { stack, hosts, override } of CASES) {
  Deno.test(`${stack} compose: an .env without the new domain keys keeps the old host`, async () => {
    assertEquals(hostsOf(await render(stack, OLD_ENV)), hosts)
  })

  Deno.test(`${stack} compose: ${override} in the .env replaces the host`, async () => {
    const rendered = await render(stack, { ...OLD_ENV, [override]: "custom.test" })
    assertEquals(hostsOf(rendered)[0], "custom.test")
  })
}

Deno.test("umami compose: the proxy hosts come from UMAMI_PROXY_DOMAIN and UMAMI_PROXY_WWW_DOMAIN", async () => {
  const rendered = await render("umami", {
    ...OLD_ENV,
    UMAMI_PROXY_DOMAIN: "site.test",
    UMAMI_PROXY_WWW_DOMAIN: "www.site.test",
  })
  assertEquals(hostsOf(rendered), ["stats.example.com", "site.test", "www.site.test"])
})

Deno.test("healthchecks compose: the site URL and allowed hosts follow the old host too", async () => {
  const rendered = await render("healthchecks", OLD_ENV)
  assert(rendered.includes("SITE_ROOT=https://healthchecks.example.com"))
  assert(rendered.includes("ALLOWED_HOSTS=localhost,hl-healthchecks,healthchecks.example.com"))
})

Deno.test("mirotalk compose: the TURN host and certificate follow the old host without MIROTALK_DOMAIN", async () => {
  const rendered = await render("mirotalk", OLD_ENV)
  assert(rendered.includes("TURN_SERVER_URL=turns:talk.example.com:5349"))
  assert(rendered.includes("--realm=talk.example.com"))
  assert(rendered.includes("--server-name=talk.example.com"))
  assert(rendered.includes("MIROTALK_DOMAIN=talk.example.com"))
})

Deno.test("mirotalk: coturn reads the certificate file the sidecar writes", async () => {
  for (const env of [OLD_ENV, { ...OLD_ENV, MIROTALK_DOMAIN: "call.test" }]) {
    const rendered = await render("mirotalk", env)
    const domain = rendered.match(/- MIROTALK_DOMAIN=(\S+)/)?.[1]
    assert(domain, "the sidecar gets no MIROTALK_DOMAIN")
    assertEquals(rendered.match(/--cert=(\S+)/)?.[1], `/certs/${domain}.crt`)
    assertEquals(rendered.match(/--pkey=(\S+)/)?.[1], `/certs/${domain}.key`)
  }
  // The sidecar names its files after that domain: `<MIROTALK_DOMAIN>.crt` and `.key`.
  const script = await Deno.readTextFile(new URL("./mirotalk/cert-extract.py", stacksDir))
  assert(
    script.includes("target = MIROTALK_DOMAIN"),
    "cert-extract.py no longer targets the domain",
  )
  assert(script.includes('CERTS_DIR / f"{target}.crt"'), "cert-extract.py changed the .crt name")
  assert(script.includes('CERTS_DIR / f"{target}.key"'), "cert-extract.py changed the .key name")
})
