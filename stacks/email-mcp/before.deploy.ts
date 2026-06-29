// Render config.toml.template into config.toml by substituting ${EMAIL_MCP_*} env vars.
// The rendered file is mounted into the email-mcp container at /config.toml
// (see MCP_EMAIL_SERVER_CONFIG_PATH in compose.yml).

const templatePath = new URL("./config.toml.template", import.meta.url).pathname
const outputPath = new URL("./config.toml", import.meta.url).pathname

const tpl = Deno.readTextFileSync(templatePath)

const keys = [
  "EMAIL_MCP_PRIMARY_USER",
  "EMAIL_MCP_PRIMARY_PASSWORD",
  "EMAIL_MCP_NEATSOFT_USER",
  "EMAIL_MCP_NEATSOFT_PASSWORD",
] as const

const missing: string[] = []
for (const k of keys) {
  if (!Deno.env.get(k)) missing.push(k)
}
if (missing.length) {
  console.error(`before.deploy.ts: missing env vars: ${missing.join(", ")}`)
  Deno.exit(1)
}

const filled = tpl.replace(/\$\{EMAIL_MCP_[A-Z0-9_]+\}/g, (m) => {
  const k = m.slice(2, -1)
  return Deno.env.get(k) ?? ""
})

Deno.writeTextFileSync(outputPath, filled, { mode: 0o600 })
console.log("config.toml rendered")
