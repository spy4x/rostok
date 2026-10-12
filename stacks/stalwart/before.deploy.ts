// Prepares the stalwart stack before its files are synced to the server:
//
// 1. Reads STALWART_EXTRA_DOMAINS, the optional comma-separated list of further mail domains on
//    the same MX, and fails when the retired STALWART_NEATSOFT_DOMAIN is still set.
// 2. Writes what compose.yml needs per listed domain into the staging `.env` (the hook's working
//    directory is the deploy staging folder): compose cannot loop over a list, so the hook turns
//    it into one Traefik rule fragment and one host list.
// 3. Keeps DKIM management manual on the live server for the primary and every extra domain.
// 4. Renders mta-sts.txt.template → mta-sts.txt. The policy MX is the primary mail domain's
//    (DOMAIN), which every extra domain shares.

import { ensureManualDkimManagement } from "./dkim.ts"

const templatePath =
  new URL("./mta-sts/html/.well-known/mta-sts.txt.template", import.meta.url).pathname
const outputPath = new URL("./mta-sts/html/.well-known/mta-sts.txt", import.meta.url).pathname

const DOMAIN_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

/** Keys this hook writes into the staging `.env`; compose.yml reads them, nobody sets them. */
export const DERIVED_KEYS = ["STALWART_MTA_STS_EXTRA_RULE", "STALWART_CERT_SYNC_EXTRA"] as const

/**
 * The extra mail domains of STALWART_EXTRA_DOMAINS: comma-separated, lower-cased, without blanks
 * or repeats, and without the primary DOMAIN (already served). Unset or empty is no extra domain.
 * Throws when a value is not a plain domain name (it ends up in a Traefik rule), and when the
 * retired STALWART_NEATSOFT_DOMAIN is set: ignoring it would silently stop serving that domain.
 */
export function resolveExtraDomains(getEnv: (key: string) => string | undefined): string[] {
  const retired = getEnv("STALWART_NEATSOFT_DOMAIN")?.trim()
  if (retired) {
    throw new Error(
      "STALWART_NEATSOFT_DOMAIN is no longer read. Rename it to STALWART_EXTRA_DOMAINS in the " +
        "server's .env (a comma-separated list of further mail domains; leave it out when " +
        "DOMAIN is the only one), then deploy again.",
    )
  }
  const primary = getEnv("DOMAIN")?.trim().toLowerCase()
  const domains: string[] = []
  for (const raw of (getEnv("STALWART_EXTRA_DOMAINS") ?? "").split(",")) {
    const domain = raw.trim().toLowerCase()
    // `${DOMAIN}` is what the retired key held by default: the primary domain, nothing extra.
    if (!domain || domain === primary || raw.trim() === "${DOMAIN}" || domains.includes(domain)) {
      continue
    }
    if (!DOMAIN_RE.test(domain)) {
      throw new Error(`STALWART_EXTRA_DOMAINS: "${domain}" is not a plain domain name`)
    }
    domains.push(domain)
  }
  return domains
}

/**
 * What compose.yml appends per extra domain: a Traefik rule fragment that routes each
 * `mta-sts.<domain>` to the policy server, and the `mail.<domain>` hosts whose certificates the
 * cert-sync sidecar copies. Both are empty strings when there is no extra domain.
 */
export function derivedEnv(extraDomains: string[]): Record<(typeof DERIVED_KEYS)[number], string> {
  return {
    STALWART_MTA_STS_EXTRA_RULE: extraDomains.map((d) => ` || Host(\`mta-sts.${d}\`)`).join(""),
    STALWART_CERT_SYNC_EXTRA: extraDomains.map((d) => `,mail.${d}`).join(""),
  }
}

/**
 * `envText` with every `DERIVED_KEYS` line replaced by the values for `extraDomains`. A key with
 * an empty value is left out, so compose falls back to the primary domain alone. Values are
 * single-quoted: compose reads them literally, backticks and leading space included.
 */
export function withDerivedEnv(envText: string, extraDomains: string[]): string {
  const kept = envText.split("\n").filter((line) =>
    !DERIVED_KEYS.some((key) => line.trimStart().startsWith(`${key}=`))
  )
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop()
  for (const [key, value] of Object.entries(derivedEnv(extraDomains))) {
    if (value) kept.push(`${key}='${value}'`)
  }
  return kept.join("\n") + "\n"
}

/** Run the hook. `envPath` is the staging `.env`, relative to the working directory. */
async function main(envPath: string): Promise<void> {
  const missing = ["DOMAIN", "STALWART_ADMIN_PASSWORD"].filter((k) => !Deno.env.get(k))
  if (missing.length) throw new Error(`missing env vars: ${missing.join(", ")}`)

  const domain = Deno.env.get("DOMAIN")!
  const extraDomains = resolveExtraDomains((key) => Deno.env.get(key))
  await Deno.writeTextFile(envPath, withDerivedEnv(await Deno.readTextFile(envPath), extraDomains))
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
      throw new Error(`live Stalwart health check failed: HTTP ${response.status}`)
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

  const tpl = Deno.readTextFileSync(templatePath)
  const filled = tpl.replace(/\$\{DOMAIN\}/g, domain)

  Deno.writeTextFileSync(outputPath, filled, { mode: 0o644 })
  console.log("mta-sts.txt rendered")
}

if (import.meta.main) {
  try {
    await main(".env")
  } catch (err) {
    console.error(
      "before.deploy.ts (stalwart) FAILED:",
      err instanceof Error ? err.message : String(err),
    )
    Deno.exit(1)
  }
}
