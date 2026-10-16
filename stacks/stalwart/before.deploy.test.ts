// Tests for stacks/stalwart/before.deploy.ts: the list of extra mail domains, what the hook
// writes for it into compose.yml, and the hook itself run in a deploy staging folder.

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert"
import { dirname, join } from "@std/path"
import { hostsIn, interpolate } from "../compose-interpolate.ts"
import { EXTRA_ROUTERS_MARKER, resolveExtraDomains, withExtraDomains } from "./before.deploy.ts"

/** Build a `getEnv` from a plain object. */
function envFrom(vars: Record<string, string>): (key: string) => string | undefined {
  return (key) => vars[key]
}

const STACK_DIR = new URL("./", import.meta.url)

/**
 * The stalwart compose.yml as the server renders it for `extra` mail domains: the hook's edit
 * first, then compose's own `${KEY}` interpolation with `env`.
 */
async function composeFor(
  extra: string[],
  env: Record<string, string> = {},
  edit: (compose: string) => string = (compose) => compose,
): Promise<string> {
  const raw = edit(await Deno.readTextFile(new URL("compose.yml", STACK_DIR)))
  const code = withExtraDomains(raw, extra).split("\n").filter((l) => !l.trim().startsWith("#"))
  return interpolate(code.join("\n"), { DOMAIN: "example.com", ...env })
}

/** The labels of the router `name` in a rendered compose file, as `key=value` without the prefix. */
function routerLabels(rendered: string, name: string): string[] {
  const prefix = `"traefik.http.routers.${name}.`
  return rendered.split("\n").map((l) => l.trim().replace(/^- /, "")).filter((l) =>
    l.startsWith(prefix)
  ).map((l) => l.slice(prefix.length, -1))
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

Deno.test("STALWART_NEATSOFT_DOMAIN naming a second domain gets an error naming STALWART_EXTRA_DOMAINS", () => {
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

Deno.test("STALWART_NEATSOFT_DOMAIN that is blank, ${DOMAIN} or the primary domain is ignored with one notice", () => {
  for (const retired of ["", "  ", "${DOMAIN}", "example.com", " Example.COM "]) {
    const notices: string[] = []
    const domains = resolveExtraDomains(
      envFrom({
        DOMAIN: "example.com",
        STALWART_NEATSOFT_DOMAIN: retired,
        STALWART_EXTRA_DOMAINS: "example.org",
      }),
      (line) => notices.push(line),
    )
    assertEquals(domains, ["example.org"], `retired key "${retired}"`)
    assertEquals(notices.length, 1, `retired key "${retired}"`)
    assertStringIncludes(notices[0], "STALWART_NEATSOFT_DOMAIN")
    assertEquals(notices[0].includes("\n"), false)
  }
})

Deno.test("a project without STALWART_NEATSOFT_DOMAIN gets no notice", () => {
  const notices: string[] = []
  resolveExtraDomains(envFrom({ DOMAIN: "example.com" }), (line) => notices.push(line))
  assertEquals(notices, [])
})

Deno.test("compose: without extra domains the hosts are the primary domain's only", async () => {
  const text = await composeFor([])
  assertEquals([...new Set(hostsIn(text))].sort(), ["mail.example.com", "mta-sts.example.com"])
  assertStringIncludes(text, "CERT_SYNC_DOMAINS=mail.example.com\n")
})

Deno.test("compose: every extra domain gets its own MTA-STS router and its certificate synced", async () => {
  const text = await composeFor(["example.org", "sub.example.net"])
  const own = [
    "middlewares=frame-deny@file,robots-deny@file",
    "entrypoints=websecure",
    "tls=true",
    "tls.certresolver=myresolver",
    "service=hl-mta-sts",
  ]
  assertEquals(routerLabels(text, "hl-mta-sts-example_org"), [
    "rule=Host(`mta-sts.example.org`)",
    ...own,
  ])
  assertEquals(routerLabels(text, "hl-mta-sts-sub_example_net"), [
    "rule=Host(`mta-sts.sub.example.net`)",
    ...own,
  ])
  assertStringIncludes(
    text,
    "CERT_SYNC_DOMAINS=mail.example.com,mail.example.org,mail.sub.example.net\n",
  )
})

Deno.test("compose: the primary MTA-STS host keeps a router of its own, whatever the extra domains", async () => {
  for (const extra of [[], ["example.org", "example.net"]]) {
    const text = await composeFor(extra)
    assertEquals(routerLabels(text, "hl-mta-sts-primary"), [
      "rule=Host(`mta-sts.example.com`)",
      "middlewares=frame-deny@file,robots-deny@file",
      "entrypoints=websecure",
      "tls=true",
      "tls.certresolver=myresolver",
    ])
  }
  // One host per rule: a rule naming two hosts would put them in one certificate order.
  const rules = (await composeFor(["example.org", "example.net"])).split("\n").filter((l) =>
    l.includes(".rule=")
  )
  for (const rule of rules) assertEquals(hostsIn(rule).length, 1, rule)
})

Deno.test("compose: the added routers are list items of the mta-sts service's labels", async () => {
  const raw = await Deno.readTextFile(new URL("compose.yml", STACK_DIR))
  const lines = withExtraDomains(raw, ["example.org"]).split("\n")
  const added = lines.findIndex((l) => l.includes("hl-mta-sts-example_org.rule="))
  const primary = lines.findIndex((l) => l.includes("hl-mta-sts-primary.rule="))
  const indent = (l: string) => l.slice(0, l.indexOf("-"))
  assertEquals(indent(lines[added]), indent(lines[primary]))
  // Still inside the mta-sts service: the next service starts after the added lines.
  const nextService = lines.findIndex((l, i) => i > primary && /^ {2}[a-z-]+:$/.test(l))
  assertEquals(added > primary && added < nextService, true)
})

Deno.test("a compose.yml without the marker or the cert-sync line fails instead of dropping the extra domains", async () => {
  const raw = await Deno.readTextFile(new URL("compose.yml", STACK_DIR))
  const noMarker = raw.replace(EXTRA_ROUTERS_MARKER, "# nothing here")
  assertThrows(() => withExtraDomains(noMarker, ["example.org"]), Error, "exactly once")
  const noCertLine = raw.replace("- CERT_SYNC_DOMAINS=", "- CERT_DOMAINS=")
  assertThrows(() => withExtraDomains(noCertLine, ["example.org"]), Error, "exactly once")
  assertThrows(() => withExtraDomains(noMarker, []), Error, "exactly once")
})

Deno.test("compose: the webmail origin allowed to call JMAP defaults to webmail.<domain>", async () => {
  const header = "hl-stalwart-jmap.headers.customresponseheaders.Access-Control-Allow-Origin="
  assertStringIncludes(await composeFor([]), `${header}https://webmail.example.com"`)
  assertStringIncludes(
    await composeFor([], { STALWART_WEBMAIL_ORIGIN: "https://post.example.net" }),
    `${header}https://post.example.net"`,
  )
})

Deno.test("compose: the JMAP router uses the stack's own CORS middleware, not one from Traefik's files", async () => {
  const text = await composeFor([])
  assertStringIncludes(
    text,
    '"traefik.http.routers.hl-stalwart.middlewares=frame-deny@file,hl-stalwart-jmap@docker,robots-deny@file"',
  )
  assertEquals(text.includes("stalwart-jmap@file"), false)
})

Deno.test("compose: the stack's CORS middleware sets all five headers the webmail needs", async () => {
  const prefix = '"traefik.http.middlewares.hl-stalwart-jmap.headers.customresponseheaders.'
  const headers = (await composeFor([])).split("\n").map((l) => l.trim().replace(/^- /, ""))
    .filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length, -1)).sort()
  assertEquals(headers, [
    "Access-Control-Allow-Headers=Content-Type, Authorization",
    "Access-Control-Allow-Methods=GET, POST, OPTIONS",
    "Access-Control-Allow-Origin=https://webmail.example.com",
    "Cross-Origin-Embedder-Policy=unsafe-none",
    "Cross-Origin-Resource-Policy=cross-origin",
  ])
})

/** Shipped files the hook reads in staging, relative to the stack folder. */
const STAGED_FILES = ["compose.yml", "mta-sts/html/.well-known/mta-sts.txt.template"]

/** A deploy staging folder holding the stalwart files the hook reads, and a server `.env`. */
async function makeStaging(envText = "PROJECT=demo\n"): Promise<string> {
  const staging = await Deno.makeTempDir({ prefix: "rostok-stalwart-hook-" })
  for (const rel of STAGED_FILES) {
    const dest = join(staging, "stacks", "stalwart", rel)
    await Deno.mkdir(dirname(dest), { recursive: true })
    await Deno.copyFile(new URL(rel, STACK_DIR), dest)
  }
  await Deno.writeTextFile(join(staging, ".env"), envText)
  return staging
}

/** Run the hook in `staging` with `env`, like `rostok deploy` does: from its source, cwd staging. */
async function runHook(
  staging: string,
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL("before.deploy.ts", STACK_DIR).href],
    cwd: staging,
    // A domain that never resolves: the hook must not reach a real server.
    env: { DOMAIN: "example.invalid", STALWART_ADMIN_PASSWORD: "x", ...env },
    stdout: "piped",
    stderr: "piped",
  }).output()
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
  return { code: out.code, stdout: text(out.stdout), stderr: text(out.stderr) }
}

/** Every file under `dir`, relative, sorted. */
async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  const found: string[] = []
  for await (const entry of Deno.readDir(dir)) {
    const rel = prefix + entry.name
    if (entry.isDirectory) found.push(...await filesUnder(join(dir, entry.name), `${rel}/`))
    else found.push(rel)
  }
  return found.sort()
}

Deno.test("the hook writes every extra domain into the staged compose.yml and leaves .env alone", async () => {
  const staging = await makeStaging("PROJECT=demo\nSTALWART_EXTRA_DOMAINS=example.org\n")
  try {
    const out = await runHook(staging, {
      STALWART_INITIAL_DEPLOY: "true",
      STALWART_EXTRA_DOMAINS: "example.org, example.net",
    })
    assertEquals(out.code, 0, out.stderr)
    const compose = await Deno.readTextFile(join(staging, "stacks", "stalwart", "compose.yml"))
    assertStringIncludes(compose, "hl-mta-sts-example_org.rule=Host(`mta-sts.example.org`)")
    assertStringIncludes(compose, "hl-mta-sts-example_net.rule=Host(`mta-sts.example.net`)")
    assertStringIncludes(
      compose,
      "- CERT_SYNC_DOMAINS=${STALWART_DOMAIN:-mail.${DOMAIN}},mail.example.org,mail.example.net\n",
    )
    assertEquals(
      await Deno.readTextFile(join(staging, ".env")),
      "PROJECT=demo\nSTALWART_EXTRA_DOMAINS=example.org\n",
    )
  } finally {
    await Deno.remove(staging, { recursive: true })
  }
})

Deno.test("the hook renders the staged MTA-STS template into the staged stack folder, not next to its source", async () => {
  const sourceBefore = await filesUnder(STACK_DIR.pathname)
  const staging = await makeStaging()
  const policyDir = join(staging, "stacks", "stalwart", "mta-sts", "html", ".well-known")
  // A staged template that differs from the source's shows which one the hook reads.
  await Deno.writeTextFile(join(policyDir, "mta-sts.txt.template"), "staged\nmx: mail.${DOMAIN}\n")
  try {
    const out = await runHook(staging, { STALWART_INITIAL_DEPLOY: "true" })
    assertEquals(out.code, 0, out.stderr)
    assertEquals(
      await Deno.readTextFile(join(policyDir, "mta-sts.txt")),
      "staged\nmx: mail.example.invalid\n",
    )
    // Everything the hook wrote is under stacks/stalwart/ in staging.
    assertEquals(await filesUnder(staging), [
      ".env",
      "stacks/stalwart/compose.yml",
      "stacks/stalwart/mta-sts/html/.well-known/mta-sts.txt",
      "stacks/stalwart/mta-sts/html/.well-known/mta-sts.txt.template",
    ])
    assertEquals(await filesUnder(STACK_DIR.pathname), sourceBefore)
  } finally {
    await Deno.remove(staging, { recursive: true })
  }
})

Deno.test("the hook stops the deploy when STALWART_NEATSOFT_DOMAIN names a second domain", async () => {
  const staging = await makeStaging()
  try {
    const out = await runHook(staging, {
      STALWART_INITIAL_DEPLOY: "true",
      STALWART_NEATSOFT_DOMAIN: "example.org",
    })
    assertEquals(out.code, 1)
    assertStringIncludes(out.stderr, "Rename it to STALWART_EXTRA_DOMAINS")
    const compose = await Deno.readTextFile(join(staging, "stacks", "stalwart", "compose.yml"))
    assertStringIncludes(compose, EXTRA_ROUTERS_MARKER)
  } finally {
    await Deno.remove(staging, { recursive: true })
  }
})

Deno.test("the hook carries on with a notice when STALWART_NEATSOFT_DOMAIN is ${DOMAIN}", async () => {
  const staging = await makeStaging()
  try {
    const out = await runHook(staging, {
      STALWART_INITIAL_DEPLOY: "true",
      STALWART_NEATSOFT_DOMAIN: "${DOMAIN}",
    })
    assertEquals(out.code, 0, out.stderr)
    assertStringIncludes(out.stderr, "STALWART_NEATSOFT_DOMAIN is no longer read")
  } finally {
    await Deno.remove(staging, { recursive: true })
  }
})
