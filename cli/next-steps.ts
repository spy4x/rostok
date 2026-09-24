// "What now?" output after the wizard and after `stack add` (#212).
//
// A first-timer who just watched the wizard write files has no idea
// what to do next: run a deploy? point DNS somewhere? The old output
// ended with "wizard complete." and nothing else; `stack add` printed
// only a one-line summary. Both now end with the same block: which
// files were actually written, the exact command(s) to run next, and
// the DNS records to create.

import { join } from "@std/path"
import { readEnvFile } from "./env-files.ts"
import { readServerConfig } from "./stack-add.ts"
import { parseSshAddress as parseSshTarget } from "./server-keys.ts"

export interface NextStepsInput {
  serverName: string
  /** `servers/<name>` — absolute or relative to cwd, whichever the caller already has. */
  serverDir: string
  /**
   * Files this run *tried* to write, for the "Wrote:" line — relative
   * paths look best. Filtered down to files that actually exist: a
   * caller that always names `.env` + `config.json` shouldn't claim
   * `config.json` was written when the wizard's stack step was skipped
   * and no stack was ever added.
   */
  written: string[]
  /**
   * Stack names still missing a `requires` dependency the user chose not
   * to add (or that a caller running non-interactively skipped) — each
   * gets its own `rostok stack add <name> -s <server>` suggestion.
   */
  missingRequires?: string[]
}

type HostFamily = "ipv4" | "ipv6" | "other"

/** IPv4 dotted-quad, for classifying an already-parsed host. */
const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/**
 * Classify an already-parsed host (no user, no port, no brackets — see
 * `parseSshAddress` in server-keys.ts) for the DNS record type it needs:
 * `A` for IPv4, `AAAA` for anything with a `:` (IPv6 — bare or was
 * bracketed), `other` for an alias/hostname.
 */
function classifyHost(host: string): HostFamily {
  if (IPV4_PATTERN.test(host)) return "ipv4"
  if (host.includes(":")) return "ipv6"
  return "other"
}

/**
 * Parse an SSH_ADDRESS for the DNS-record hint, via the same
 * `parseSshAddress` deploy and the SSH probe use (server-keys.ts) — so
 * a bracketed `[2001:db8::1]:2222` or a plain `203.0.113.9:2222` is
 * stripped of its port exactly the same way everywhere. Falls back to
 * `family: "other"` on anything `parseSshAddress` itself would reject
 * (e.g. a value hand-edited into `.env` after the fact) rather than
 * throwing — this is a display hint, not a validity check.
 */
function parseSshAddress(sshAddress: string): { host: string; family: HostFamily } {
  try {
    const target = parseSshTarget(sshAddress)
    return { host: target.host, family: classifyHost(target.host) }
  } catch {
    const at = sshAddress.lastIndexOf("@")
    const host = at >= 0 ? sshAddress.slice(at + 1) : sshAddress
    return { host, family: "other" }
  }
}

/** Paths from `paths` that actually exist on disk right now (relative to the process cwd). */
async function existingPaths(paths: string[]): Promise<string[]> {
  const out: string[] = []
  for (const p of paths) {
    try {
      await Deno.stat(p)
      out.push(p)
    } catch {
      // wasn't actually written this run — omit it from "Wrote:".
    }
  }
  return out
}

/**
 * Build the "Next steps" lines: files actually written, commands to run
 * next (missing requirements first, then either `rostok deploy
 * <server>` — when at least one stack is configured — or a
 * `rostok stack add <name> -s <server>` placeholder when none is, since
 * deploying an empty server does nothing useful), and — when the
 * server's `.env` has a DOMAIN — the DNS records to create.
 */
export async function buildNextSteps(input: NextStepsInput): Promise<string[]> {
  const lines: string[] = []

  const wrote = await existingPaths(input.written)
  if (wrote.length > 0) {
    lines.push("Wrote:")
    for (const f of wrote) lines.push(`  ${f}`)
    lines.push("")
  }

  lines.push("Next steps:")
  for (const name of input.missingRequires ?? []) {
    lines.push(`  rostok stack add ${name} -s ${input.serverName}`)
  }

  const cfg = await readServerConfig(input.serverDir).catch(() => ({ stacks: [] }))
  if (cfg.stacks.length > 0) {
    lines.push(`  rostok deploy ${input.serverName}`)
  } else {
    lines.push(`  rostok stack add <name> -s ${input.serverName}`)
  }

  const envPath = join(input.serverDir, ".env")
  const entries = await readEnvFile(envPath).catch(() => [])
  const byKey = new Map(entries.map((e) => [e.key, e.value]))
  const domain = byKey.get("DOMAIN")
  const sshAddress = byKey.get("SSH_ADDRESS")

  if (domain) {
    lines.push("")
    lines.push("DNS records:")

    if (sshAddress === undefined) {
      lines.push(`  A ${domain} → <server IP>`)
      lines.push(`  A *.${domain} → <server IP>`)
      lines.push(
        "  (SSH_ADDRESS isn't set yet — look up the server's public IP and use it for both " +
          "records above.)",
      )
    } else {
      const { host, family } = parseSshAddress(sshAddress)
      if (family === "ipv4") {
        lines.push(`  A ${domain} → ${host}`)
        lines.push(`  A *.${domain} → ${host}`)
      } else if (family === "ipv6") {
        lines.push(`  AAAA ${domain} → ${host}`)
        lines.push(`  AAAA *.${domain} → ${host}`)
      } else {
        lines.push(`  A ${domain} → <server IP>`)
        lines.push(`  A *.${domain} → <server IP>`)
        lines.push(
          `  (SSH_ADDRESS "${sshAddress}" isn't a plain IP — look up the server's public IP ` +
            "and use it for both records above.)",
        )
      }
    }
  }

  return lines
}
