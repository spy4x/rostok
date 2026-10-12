// Prepares the stalwart stack before its files are synced to the server. The hook's working
// directory is the deploy staging folder, and everything it writes goes into the staged
// `stacks/stalwart/` folder, the only place that both reaches the server and stays there when
// another stack is deployed alone. The hook's own source folder is read-only when rostok is
// installed from JSR, and nothing written there is synced.
//
// 1. Reads STALWART_EXTRA_DOMAINS, the optional comma-separated list of further mail domains on
//    the same MX. The retired STALWART_NEATSOFT_DOMAIN fails the deploy when it names a second
//    domain, and is ignored with a notice when it does not.
// 2. Writes what compose.yml needs per listed domain into the staged compose.yml: compose cannot
//    loop over a list, so the hook adds one Traefik router per domain and extends the list of
//    certificates the cert-sync sidecar copies.
// 3. Keeps DKIM management manual on the live server for the primary and every extra domain.
// 4. Renders the staged mta-sts.txt.template into mta-sts.txt beside it. The policy MX is the
//    primary mail domain's (DOMAIN), which every extra domain shares.

import { ensureManualDkimManagement } from "./dkim.ts"

/** The stack's folder in the deploy staging tree, relative to the hook's working directory. */
export const STAGED_DIR = "stacks/stalwart"
const POLICY_DIR = `${STAGED_DIR}/mta-sts/html/.well-known`

/** The comment line in compose.yml that the hook replaces with one router per extra domain. */
export const EXTRA_ROUTERS_MARKER = "# rostok:extra-mta-sts-routers"

const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

/**
 * The extra mail domains of STALWART_EXTRA_DOMAINS: comma-separated, lower-cased, without blanks
 * or repeats, and without the primary DOMAIN (already served). Unset or empty is no extra domain.
 * Throws when a value is not a plain domain name (it ends up in a Traefik rule).
 *
 * The retired STALWART_NEATSOFT_DOMAIN throws when it names a second domain: ignoring it would
 * silently stop serving that domain. Blank, `${DOMAIN}` or equal to DOMAIN it never added a
 * domain, so it is ignored and `notice` gets one line saying so.
 */
export function resolveExtraDomains(
  getEnv: (key: string) => string | undefined,
  notice: (line: string) => void = () => {},
): string[] {
  const primary = getEnv("DOMAIN")?.trim().toLowerCase()
  // `${DOMAIN}` arrives unexpanded: a hook gets the `.env` values as written.
  const isPrimary = (raw: string) =>
    raw.trim() === "${DOMAIN}" || raw.trim().toLowerCase() === primary

  const retired = getEnv("STALWART_NEATSOFT_DOMAIN")
  if (retired !== undefined) {
    if (retired.trim() && !isPrimary(retired)) {
      throw new Error(
        "STALWART_NEATSOFT_DOMAIN is no longer read. Rename it to STALWART_EXTRA_DOMAINS in the " +
          "server's .env (a comma-separated list of further mail domains), then deploy again.",
      )
    }
    notice("STALWART_NEATSOFT_DOMAIN is no longer read and adds no mail domain: remove it.")
  }

  const domains: string[] = []
  for (const raw of (getEnv("STALWART_EXTRA_DOMAINS") ?? "").split(",")) {
    const domain = raw.trim().toLowerCase()
    if (!domain || isPrimary(raw) || domains.includes(domain)) continue
    if (!DOMAIN_RE.test(domain)) {
      throw new Error(`STALWART_EXTRA_DOMAINS: "${domain}" is not a plain domain name`)
    }
    domains.push(domain)
  }
  return domains
}

/**
 * The Traefik labels of one extra domain's MTA-STS router. Each domain gets its own router, so
 * Traefik orders its certificate alone: a domain whose DNS record is missing fails by itself and
 * costs no other host its certificate. A dot cannot be part of a router name, and a domain name
 * holds no underscore, so `_` keeps the names distinct.
 */
function extraRouterLabels(domain: string): string[] {
  const router = `traefik.http.routers.hl-mta-sts-${domain.replaceAll(".", "_")}`
  return [
    `${router}.rule=Host(\`mta-sts.${domain}\`)`,
    `${router}.middlewares=robots-deny@file`,
    `${router}.entrypoints=websecure`,
    `${router}.tls=true`,
    `${router}.tls.certresolver=myresolver`,
    `${router}.service=hl-mta-sts`,
  ]
}

/**
 * `composeText` (the stack's compose.yml) for `extraDomains`: the marker line becomes one MTA-STS
 * router per domain, and the cert-sync list gains each domain's `mail.` host. With no extra
 * domain the marker line is dropped and nothing else changes. Throws when the marker or the
 * cert-sync line is not there exactly once: a compose.yml this function no longer fits must fail
 * the deploy, not drop the extra domains.
 */
export function withExtraDomains(composeText: string, extraDomains: string[]): string {
  const lines = composeText.split("\n")
  const markers = lines.flatMap((line, i) => line.trim() === EXTRA_ROUTERS_MARKER ? [i] : [])
  const certLines = lines.flatMap((line, i) => /^\s*- CERT_SYNC_DOMAINS=\S+$/.test(line) ? [i] : [])
  if (markers.length !== 1 || certLines.length !== 1) {
    throw new Error(
      `compose.yml must hold the line "${EXTRA_ROUTERS_MARKER}" and one CERT_SYNC_DOMAINS ` +
        `line, each exactly once (found ${markers.length} and ${certLines.length})`,
    )
  }
  lines[certLines[0]] += extraDomains.map((d) => `,mail.${d}`).join("")
  const indent = lines[markers[0]].slice(0, lines[markers[0]].indexOf("#"))
  const labels = extraDomains.flatMap(extraRouterLabels).map((label) => `${indent}- "${label}"`)
  lines.splice(markers[0], 1, ...labels)
  return lines.join("\n")
}

/**
 * Added to the health check's error on a 404. Traefik answers 404 for a router it disabled, which
 * is what an upgraded traefik stack does to a stalwart stack deployed before the upgrade: that
 * one's web router still names the `stalwart-jmap@file` middleware Traefik no longer has.
 */
const NOT_ROUTED_HINT = ". Traefik has no working router for the mail host. If the traefik stack " +
  "was upgraded before this one, deploy stalwart once with STALWART_INITIAL_DEPLOY=true: that " +
  "brings the router back. With that flag a failed check after the deploy stops the mail " +
  "container; deploying again without the flag starts it. See the stack README, " +
  '"Upgrading from STALWART_NEATSOFT_DOMAIN".'

/** Run the hook. `stagingDir` is the deploy staging folder. */
async function main(stagingDir: string): Promise<void> {
  const missing = ["DOMAIN", "STALWART_ADMIN_PASSWORD"].filter((k) => !Deno.env.get(k))
  if (missing.length) throw new Error(`missing env vars: ${missing.join(", ")}`)

  const domain = Deno.env.get("DOMAIN")!
  const extraDomains = resolveExtraDomains((key) => Deno.env.get(key), console.warn)
  const composePath = `${stagingDir}/${STAGED_DIR}/compose.yml`
  await Deno.writeTextFile(
    composePath,
    withExtraDomains(await Deno.readTextFile(composePath), extraDomains),
  )
  if (extraDomains.length > 0) console.log(`Extra mail domains: ${extraDomains.join(", ")}`)

  const password = Deno.env.get("STALWART_ADMIN_PASSWORD")!
  const allowInitialDeploy = Deno.env.get("STALWART_INITIAL_DEPLOY") === "true"
  let liveServerAvailable: boolean
  try {
    const response = await fetch(`https://mail.${domain}/healthz/live`, {
      signal: AbortSignal.timeout(5_000),
    })
    liveServerAvailable = response.ok
    if (!response.ok && !allowInitialDeploy) {
      throw new Error(
        `live Stalwart health check failed: HTTP ${response.status}` +
          (response.status === 404 ? NOT_ROUTED_HINT : ""),
      )
    }
  } catch (err) {
    if (!allowInitialDeploy) throw err
    liveServerAvailable = false
    console.warn("Skipping DKIM preflight for explicit initial deployment")
  }
  if (liveServerAvailable) {
    const updated = await ensureManualDkimManagement(domain, password, [domain, ...extraDomains])
    if (updated > 0) console.log(`Set manual DKIM management for ${updated} domain(s)`)
  }

  const template = await Deno.readTextFile(`${stagingDir}/${POLICY_DIR}/mta-sts.txt.template`)
  await Deno.writeTextFile(
    `${stagingDir}/${POLICY_DIR}/mta-sts.txt`,
    template.replace(/\$\{DOMAIN\}/g, domain),
    { mode: 0o644 },
  )
  console.log("mta-sts.txt rendered")
}

if (import.meta.main) {
  try {
    await main(".")
  } catch (err) {
    console.error(
      "before.deploy.ts (stalwart) FAILED:",
      err instanceof Error ? err.message : String(err),
    )
    Deno.exit(1)
  }
}
