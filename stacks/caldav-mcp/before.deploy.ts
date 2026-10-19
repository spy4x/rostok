// before.deploy.ts — stops a public deploy that has no trusted proxy (spy4x/rostok#411).
//
// caldav-mcp answers `429` to every request from a client address after ten failed ones in a
// minute, the right token included. Behind Traefik with CALDAV_MCP_TRUSTED_PROXIES blank, every
// request carries Traefik's address, so the whole internet shares one address and anyone can lock
// the owner's own agents out. An internal server (route off) needs no trusted proxy and deploys
// with the key blank.
//
// Self-contained per the hook contract: no import out of this stack folder, nothing written.

/** The values Traefik's `traefik.enable` label reads as true (Go's strconv.ParseBool). */
const TRUE_VALUES = new Set([`1`, `t`, `T`, `true`, `TRUE`, `True`])

/**
 * Throws, naming CALDAV_MCP_TRUSTED_PROXIES and the README section, when CALDAV_MCP_PUBLIC turns
 * the Traefik route on and CALDAV_MCP_TRUSTED_PROXIES is blank. Pure, so it is testable without a
 * process.
 */
export function checkPublicRoute(getEnv: (key: string) => string | undefined): void {
  if (!TRUE_VALUES.has(getEnv(`CALDAV_MCP_PUBLIC`) ?? ``)) return
  if ((getEnv(`CALDAV_MCP_TRUSTED_PROXIES`) ?? ``).trim() !== ``) return
  throw new Error(
    `CALDAV_MCP_PUBLIC=true needs CALDAV_MCP_TRUSTED_PROXIES set to Traefik's address as ` +
      `<ip>/32. Without it every request shares Traefik's address, and ten bad requests a minute ` +
      `lock every client out. Set it and TRAEFIK_PROXY_IP as stacks/caldav-mcp/README.md, ` +
      `"Public with OAuth", step 2, describes, or set CALDAV_MCP_PUBLIC=false.`,
  )
}

if (import.meta.main) {
  try {
    checkPublicRoute((key) => Deno.env.get(key))
  } catch (err) {
    console.error(`before.deploy.ts FAILED:`, err instanceof Error ? err.message : String(err))
    Deno.exit(1)
  }
}
