// Render mta-sts.txt.template → mta-sts.txt by substituting env vars.
// Policy MX must match the primary mail domain (DOMAIN).

const templatePath =
  new URL("./mta-sts/html/.well-known/mta-sts.txt.template", import.meta.url).pathname
const outputPath = new URL("./mta-sts/html/.well-known/mta-sts.txt", import.meta.url).pathname

const keys = ["DOMAIN"] as const
const missing: string[] = []
for (const k of keys) {
  if (!Deno.env.get(k)) missing.push(k)
}
if (missing.length) {
  console.error(`before.deploy.ts (stalwart): missing env vars: ${missing.join(", ")}`)
  Deno.exit(1)
}

const tpl = Deno.readTextFileSync(templatePath)
const filled = tpl.replace(/\$\{DOMAIN\}/g, Deno.env.get("DOMAIN")!)

Deno.writeTextFileSync(outputPath, filled, { mode: 0o644 })
console.log("mta-sts.txt rendered")
