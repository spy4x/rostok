// "What now?" output after the wizard and after `stack add` (#212).
//
// A first-timer who just watched the wizard write files has no idea
// what to do next: run a deploy? point DNS somewhere? The old output
// ended with "wizard complete." and nothing else; `stack add` printed
// only a one-line summary. Both now end with the same block: which
// files were written, the exact command(s) to run next, and the DNS
// records to create.

import { join } from "@std/path"
import { readEnvFile } from "./env-files.ts"

export interface NextStepsInput {
  serverName: string
  /** `servers/<name>` — absolute or relative to cwd, whichever the caller already has. */
  serverDir: string
  /** Files this run actually wrote, for the "Wrote:" line — relative paths look best. */
  written: string[]
  /**
   * Stack names still missing a `requires` dependency the user chose not
   * to add (or that a caller running non-interactively skipped) — each
   * gets its own `rostok stack add <name> -s <server>` suggestion.
   */
  missingRequires?: string[]
}

/** IPv4/IPv6 literal check — loose on purpose, only used to decide whether to show a placeholder. */
function isIpAddress(host: string): boolean {
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return host.includes(":") && /^[0-9a-fA-F:]+$/.test(host)
}

/** Strip `user@` and `:port` from an SSH_ADDRESS, returning the host portion. */
function sshAddressHost(sshAddress: string): string {
  const at = sshAddress.lastIndexOf("@")
  const host = at >= 0 ? sshAddress.slice(at + 1) : sshAddress
  return host.replace(/:\d+$/, "")
}

/**
 * Build the "Next steps" lines: files written, commands to run next
 * (missing requirements first, then `rostok deploy <server>`), and — when
 * the server's `.env` has a DOMAIN — the DNS `A` records to create.
 */
export async function buildNextSteps(input: NextStepsInput): Promise<string[]> {
  const lines: string[] = []

  if (input.written.length > 0) {
    lines.push("Wrote:")
    for (const f of input.written) lines.push(`  ${f}`)
    lines.push("")
  }

  lines.push("Next steps:")
  for (const name of input.missingRequires ?? []) {
    lines.push(`  rostok stack add ${name} -s ${input.serverName}`)
  }
  lines.push(`  rostok deploy ${input.serverName}`)

  const envPath = join(input.serverDir, ".env")
  const entries = await readEnvFile(envPath).catch(() => [])
  const byKey = new Map(entries.map((e) => [e.key, e.value]))
  const domain = byKey.get("DOMAIN")
  const sshAddress = byKey.get("SSH_ADDRESS")

  if (domain) {
    const host = sshAddress ? sshAddressHost(sshAddress) : undefined
    const ip = host && isIpAddress(host) ? host : undefined
    const placeholder = ip ?? "<server IP>"

    lines.push("")
    lines.push("DNS records:")
    lines.push(`  A ${domain} → ${placeholder}`)
    lines.push(`  A *.${domain} → ${placeholder}`)
    if (!ip) {
      lines.push(
        `  (SSH_ADDRESS "${sshAddress}" isn't a plain IP — look up the server's public IP ` +
          "and use it for both records above.)",
      )
    }
  }

  return lines
}
