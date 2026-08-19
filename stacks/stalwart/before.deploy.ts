// Render mta-sts.txt.template → mta-sts.txt by substituting env vars.
// Policy MX must match the primary mail domain (DOMAIN).

import { ensureManualDkimManagement } from "./dkim.ts"

const templatePath =
  new URL("./mta-sts/html/.well-known/mta-sts.txt.template", import.meta.url).pathname
const outputPath = new URL("./mta-sts/html/.well-known/mta-sts.txt", import.meta.url).pathname

const keys = ["DOMAIN", "NEATSOFT_DOMAIN", "STALWART_ADMIN_PASSWORD"] as const
const missing: string[] = []
for (const k of keys) {
  if (!Deno.env.get(k)) missing.push(k)
}
if (missing.length) {
  console.error(`before.deploy.ts (stalwart): missing env vars: ${missing.join(", ")}`)
  Deno.exit(1)
}

const domain = Deno.env.get("DOMAIN")!
const neatsoftDomain = Deno.env.get("NEATSOFT_DOMAIN")!
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
  const updated = await ensureManualDkimManagement(
    domain,
    password,
    [domain, neatsoftDomain],
  )
  if (updated > 0) console.log(`Set manual DKIM management for ${updated} domain(s)`)
}

const tpl = Deno.readTextFileSync(templatePath)
const filled = tpl.replace(/\$\{DOMAIN\}/g, domain)

Deno.writeTextFileSync(outputPath, filled, { mode: 0o644 })
console.log("mta-sts.txt rendered")
