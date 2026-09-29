// Renders stacks/email-mcp/config.toml (mounted at /config.toml, see
// MCP_EMAIL_SERVER_CONFIG_PATH in compose.yml) from the EMAIL_MCP_* keys of the server's .env.
// One required account, one optional second account. Format:
// https://github.com/ai-zerolab/mcp-email-server (mcp_email_server/config.py).
//
// Self-contained per the deploy hook contract: no import out of this stack directory. The output
// path is relative to the working directory (the staging directory), not to import.meta.url,
// because a shipped hook runs from an https:// URL.

const OUTPUT_PATH = "stacks/email-mcp/config.toml"

/** A TOML basic string: quoted, with backslash, quote and control characters escaped. */
export function tomlString(value: string): string {
  // deno-lint-ignore no-control-regex
  const escaped = value.replace(/[\\"\u0000-\u001f\u007f]/g, (c) => {
    if (c === "\\") return "\\\\"
    if (c === '"') return '\\"'
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  })
  return `"${escaped}"`
}

interface Account {
  name: string
  fullName: string
  user: string
  password: string
}

function renderAccount(a: Account, host: string, verifySsl: boolean): string {
  const login = (port: number, security: string) =>
    [
      `user_name = ${tomlString(a.user)}`,
      `password = ${tomlString(a.password)}`,
      `host = ${tomlString(host)}`,
      `port = ${port}`,
      security,
      `verify_ssl = ${verifySsl}`,
    ].join("\n")
  return [
    `[[emails]]`,
    `account_name = ${tomlString(a.name)}`,
    `full_name = ${tomlString(a.fullName)}`,
    `email_address = ${tomlString(a.user)}`,
    ``,
    `[emails.incoming]`,
    login(993, "use_ssl = true\nstart_ssl = false"),
    ``,
    `[emails.outgoing]`,
    login(587, "use_ssl = false\nstart_ssl = true"),
    ``,
  ].join("\n")
}

/**
 * Builds config.toml from the EMAIL_MCP_* keys in `env`. Throws naming every missing required
 * key, or a second-account user without its password.
 */
export function renderConfig(env: Record<string, string | undefined>): string {
  const get = (k: string) => env[k] ?? ""
  const missing = ["EMAIL_MCP_HOST", "EMAIL_MCP_USER", "EMAIL_MCP_PASSWORD"].filter((k) => !get(k))
  if (get("EMAIL_MCP_USER_2") && !get("EMAIL_MCP_PASSWORD_2")) missing.push("EMAIL_MCP_PASSWORD_2")
  if (missing.length) throw new Error(`missing env vars: ${missing.join(", ")}`)

  const host = get("EMAIL_MCP_HOST")
  const verifySsl = get("EMAIL_MCP_VERIFY_SSL") === "true"
  const accounts: Account[] = [{
    name: get("EMAIL_MCP_ACCOUNT_NAME") || "main",
    fullName: get("EMAIL_MCP_FULL_NAME") || get("EMAIL_MCP_USER"),
    user: get("EMAIL_MCP_USER"),
    password: get("EMAIL_MCP_PASSWORD"),
  }]
  if (get("EMAIL_MCP_USER_2")) {
    accounts.push({
      name: get("EMAIL_MCP_ACCOUNT_NAME_2") || "second",
      fullName: get("EMAIL_MCP_FULL_NAME_2") || get("EMAIL_MCP_USER_2"),
      user: get("EMAIL_MCP_USER_2"),
      password: get("EMAIL_MCP_PASSWORD_2"),
    })
  }
  return [
    `# Rendered by stacks/email-mcp/before.deploy.ts. Do not edit.`,
    `# Attachments disabled: enable explicitly if a tool needs them.`,
    `# Top-level keys come first: after a [table] header they would belong to that table.`,
    `enable_attachment_download = false`,
    ``,
    ...accounts.map((a) => renderAccount(a, host, verifySsl)),
  ].join("\n")
}

if (import.meta.main) {
  try {
    await Deno.writeTextFile(OUTPUT_PATH, renderConfig(Deno.env.toObject()), { mode: 0o600 })
    console.log("config.toml rendered")
  } catch (err) {
    console.error(`before.deploy.ts: ${err instanceof Error ? err.message : err}`)
    Deno.exit(1)
  }
}
