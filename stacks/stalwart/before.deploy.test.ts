// Tests for stacks/stalwart/before.deploy.ts: the list of extra mail domains, what the hook
// derives from it for compose.yml, and the hook itself run in a deploy staging folder.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import { join } from "@std/path"
import { hostsIn, renderCompose } from "../compose-interpolate.ts"
import { derivedEnv, resolveExtraDomains, withDerivedEnv } from "./before.deploy.ts"

/** Build a `getEnv` from a plain object. */
function envFrom(vars: Record<string, string>): (key: string) => string | undefined {
  return (key) => vars[key]
}

/** The stalwart compose.yml as the server renders it for `extra` mail domains. */
function composeFor(extra: string[]): Promise<string> {
  return renderCompose("stalwart", { DOMAIN: "example.com", ...derivedEnv(extra) })
}

Deno.test("STALWART_EXTRA_DOMAINS: unset or blank means no extra mail domain", () => {
  assertEquals(resolveExtraDomains(envFrom({ DOMAIN: "example.com" })), [])
  assertEquals(
    resolveExtraDomains(envFrom({ DOMAIN: "example.com", STALWART_EXTRA_DOMAINS: " , " })),
    [],
  )
})

Deno.test("STALWART_EXTRA_DOMAINS: lists every domain once, trimmed and lower-cased", () => {
  assertEquals(
    resolveExtraDomains(envFrom({
      DOMAIN: "example.com",
      STALWART_EXTRA_DOMAINS: "example.org, Example.NET ,example.org,",
    })),
    ["example.org", "example.net"],
  )
})

Deno.test("STALWART_EXTRA_DOMAINS: the primary domain, also as ${DOMAIN}, is not an extra one", () => {
  assertEquals(
    resolveExtraDomains(envFrom({
      DOMAIN: "example.com",
      STALWART_EXTRA_DOMAINS: "${DOMAIN},example.com,example.org",
    })),
    ["example.org"],
  )
})

Deno.test("STALWART_EXTRA_DOMAINS: a value that is not a plain domain name fails the deploy", () => {
  for (const bad of ["example.org`) || Host(`x", "exa mple.org", "https://example.org", "org"]) {
    assertThrows(
      () => resolveExtraDomains(envFrom({ DOMAIN: "example.com", STALWART_EXTRA_DOMAINS: bad })),
      Error,
      "is not a plain domain name",
      bad,
    )
  }
})

Deno.test("a project that still sets STALWART_NEATSOFT_DOMAIN gets an error naming STALWART_EXTRA_DOMAINS", () => {
  assertThrows(
    () =>
      resolveExtraDomains(envFrom({
        DOMAIN: "example.com",
        STALWART_NEATSOFT_DOMAIN: "example.org",
      })),
    Error,
    "Rename it to STALWART_EXTRA_DOMAINS",
  )
})

Deno.test("compose: without extra domains the hosts are the primary domain's only", async () => {
  const text = await composeFor([])
  assertEquals([...new Set(hostsIn(text))].sort(), ["mail.example.com", "mta-sts.example.com"])
  assertStringIncludes(text, "CERT_SYNC_DOMAINS=mail.example.com\n")
})

Deno.test("compose: every extra domain gets its MTA-STS host and its certificate synced", async () => {
  const text = await composeFor(["example.org", "example.net"])
  assertStringIncludes(
    text,
    '"traefik.http.routers.hl-mta-sts.rule=Host(`mta-sts.example.com`) || ' +
      'Host(`mta-sts.example.org`) || Host(`mta-sts.example.net`)"',
  )
  assertStringIncludes(
    text,
    "CERT_SYNC_DOMAINS=mail.example.com,mail.example.org,mail.example.net\n",
  )
})

Deno.test("compose: the webmail origin allowed to call JMAP defaults to webmail.<domain>", async () => {
  const header = "hl-stalwart-jmap.headers.customresponseheaders.Access-Control-Allow-Origin="
  assertStringIncludes(await composeFor([]), `${header}https://webmail.example.com"`)
  assertStringIncludes(
    await renderCompose("stalwart", {
      DOMAIN: "example.com",
      STALWART_WEBMAIL_ORIGIN: "https://post.example.net",
    }),
    `${header}https://post.example.net"`,
  )
})

Deno.test("compose: the JMAP router uses the stack's own CORS middleware, not one from Traefik's files", async () => {
  const text = await composeFor([])
  assertStringIncludes(
    text,
    '"traefik.http.routers.hl-stalwart.middlewares=hl-stalwart-jmap@docker,robots-deny@file"',
  )
  assertEquals(text.includes("stalwart-jmap@file"), false)
})

Deno.test("the derived keys replace their old lines in .env and leave every other line alone", () => {
  const before = "DOMAIN=example.com\nSTALWART_CERT_SYNC_EXTRA=',mail.old.example'\nA=1\n\n"
  assertEquals(
    withDerivedEnv(before, ["example.org"]),
    "DOMAIN=example.com\nA=1\n" +
      "STALWART_MTA_STS_EXTRA_RULE=' || Host(`mta-sts.example.org`)'\n" +
      "STALWART_CERT_SYNC_EXTRA=',mail.example.org'\n",
  )
  assertEquals(withDerivedEnv(before, []), "DOMAIN=example.com\nA=1\n")
})

/** Run the hook in `staging` with `env`, like `rostok deploy` does. */
async function runHook(
  staging: string,
  env: Record<string, string>,
): Promise<{ code: number; stderr: string }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL("./before.deploy.ts", import.meta.url).href],
    cwd: staging,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output()
  return { code: out.code, stderr: new TextDecoder().decode(out.stderr) }
}

Deno.test("the hook writes the derived keys into the staging .env", async () => {
  const staging = await Deno.makeTempDir()
  const rendered = new URL("./mta-sts/html/.well-known/mta-sts.txt", import.meta.url)
  try {
    await Deno.writeTextFile(join(staging, ".env"), "DOMAIN=example.invalid\n")
    // `.invalid` never resolves, and the first-deploy flag lets the hook go on without a live
    // server, so the run needs no network.
    const run = await runHook(staging, {
      DOMAIN: "example.invalid",
      STALWART_ADMIN_PASSWORD: "x",
      STALWART_EXTRA_DOMAINS: "example.org",
      STALWART_INITIAL_DEPLOY: "true",
    })
    assertEquals(run.code, 0, run.stderr)
    assertEquals(
      await Deno.readTextFile(join(staging, ".env")),
      "DOMAIN=example.invalid\n" +
        "STALWART_MTA_STS_EXTRA_RULE=' || Host(`mta-sts.example.org`)'\n" +
        "STALWART_CERT_SYNC_EXTRA=',mail.example.org'\n",
    )
  } finally {
    await Deno.remove(staging, { recursive: true })
    // The hook renders the policy file next to its source; it is gitignored build output.
    await Deno.remove(rendered).catch(() => {})
  }
})

Deno.test("the hook stops the deploy when STALWART_NEATSOFT_DOMAIN is still set", async () => {
  const staging = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(join(staging, ".env"), "DOMAIN=example.invalid\n")
    const run = await runHook(staging, {
      DOMAIN: "example.invalid",
      STALWART_ADMIN_PASSWORD: "x",
      STALWART_NEATSOFT_DOMAIN: "example.org",
      STALWART_INITIAL_DEPLOY: "true",
    })
    assertEquals(run.code, 1)
    assertStringIncludes(run.stderr, "Rename it to STALWART_EXTRA_DOMAINS")
    assertEquals(await Deno.readTextFile(join(staging, ".env")), "DOMAIN=example.invalid\n")
  } finally {
    await Deno.remove(staging, { recursive: true })
  }
})
