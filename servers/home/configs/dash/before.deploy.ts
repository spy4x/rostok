// before.deploy.ts — renders the dash dashboard and bakes gatus health.
//
// Reads index.html.template, substitutes ${DOMAIN} / ${UPTIME_HOST} /
// ${GENERATED_AT}, writes index.html. Then fetches every service's health
// and 30-day uptime badge from gatus and writes health.js so the page can
// apply down-state styling and per-section counters without CORS.
//
// Runs locally inside the deploy temp dir before files are rsynced to the
// home server. The template file is removed from the temp copy after
// rendering so it never reaches the nginx-served path (which would expose
// the unrendered template at /index.html.template).

const templateFile = new URL("index.html.template", import.meta.url).pathname
const outputFile = new URL("index.html", import.meta.url).pathname
const healthFile = new URL("health.js", import.meta.url).pathname

// Endpoint key → which gatus server exposes it. Home services are
// monitored by uptime-cloud (cloud gatus), cloud services by uptime-home
// (home gatus), offsite services by uptime-cloud.
const services: { endpoint: string; gatusBase: string }[] = [
  // Home (monitored by uptime-cloud)
  { endpoint: "home_audiobookshelf", gatusBase: "uptime-cloud" },
  { endpoint: "home_authelia", gatusBase: "uptime-cloud" },
  { endpoint: "home_docker-registry", gatusBase: "uptime-cloud" },
  { endpoint: "home_filebrowser", gatusBase: "uptime-cloud" },
  { endpoint: "home_gatus", gatusBase: "uptime-cloud" },
  { endpoint: "home_gitea", gatusBase: "uptime-cloud" },
  { endpoint: "home_home-assistant", gatusBase: "uptime-cloud" },
  { endpoint: "home_immich", gatusBase: "uptime-cloud" },
  { endpoint: "home_jellyfin", gatusBase: "uptime-cloud" },
  { endpoint: "home_librespeed", gatusBase: "uptime-cloud" },
  { endpoint: "home_metube", gatusBase: "uptime-cloud" },
  { endpoint: "home_mirotalk", gatusBase: "uptime-cloud" },
  { endpoint: "home_ntfy", gatusBase: "uptime-cloud" },
  { endpoint: "home_omni-tools", gatusBase: "uptime-cloud" },
  { endpoint: "home_open-webui", gatusBase: "uptime-cloud" },
  { endpoint: "home_opencode-web", gatusBase: "uptime-cloud" },
  { endpoint: "home_piped", gatusBase: "uptime-cloud" },
  { endpoint: "home_searxng", gatusBase: "uptime-cloud" },
  { endpoint: "home_syncthing", gatusBase: "uptime-cloud" },
  { endpoint: "home_traefik", gatusBase: "uptime-cloud" },
  { endpoint: "home_traggo", gatusBase: "uptime-cloud" },
  { endpoint: "home_transmission", gatusBase: "uptime-cloud" },
  { endpoint: "home_woodpecker-ci", gatusBase: "uptime-cloud" },
  // Cloud (monitored by uptime-home)
  { endpoint: "cloud_bulwark", gatusBase: "uptime-home" },
  { endpoint: "cloud_gatus", gatusBase: "uptime-home" },
  { endpoint: "cloud_healthchecks", gatusBase: "uptime-home" },
  { endpoint: "cloud_librespeed", gatusBase: "uptime-home" },
  { endpoint: "cloud_mail-(https)", gatusBase: "uptime-home" },
  { endpoint: "cloud_ntfy", gatusBase: "uptime-home" },
  { endpoint: "cloud_stalwart", gatusBase: "uptime-home" },
  { endpoint: "cloud_syncthing", gatusBase: "uptime-home" },
  { endpoint: "cloud_traefik", gatusBase: "uptime-home" },
  { endpoint: "cloud_vaultwarden", gatusBase: "uptime-home" },
  // Offsite (monitored by uptime-cloud)
  { endpoint: "offsite_librespeed", gatusBase: "uptime-cloud" },
  { endpoint: "offsite_syncthing", gatusBase: "uptime-cloud" },
  { endpoint: "offsite_traefik", gatusBase: "uptime-cloud" },
  // Portable
  { endpoint: "portable_opencode-web", gatusBase: "uptime-cloud" },
]

function substituteEnvVars(template: string): string {
  return template.replace(/\${([^}]+)}/g, (_match, envVarName) => {
    const value = Deno.env.get(envVarName.trim())
    if (value === undefined) {
      throw new Error(`Environment variable '${envVarName.trim()}' not found.`)
    }
    return value
  })
}

// Gatus uses fill="#40cc11" (green) for healthy and "#e05d44" (red) for
// down. The badge SVG is small enough to grep directly.
function parseHealthSvg(svg: string): boolean | null {
  if (svg.includes("#40cc11")) return true
  if (svg.includes("#e05d44")) return false
  return null
}

// The 30d uptime badge has the percentage in a <text> element. Whitespace
// may sit between the text content and the closing </text>.
function parseUptimeSvg(svg: string): number | null {
  const match = svg.match(/>\s*([\d.]+)%\s*</)
  if (!match) return null
  const n = Number(match[1])
  return Number.isFinite(n) ? n : null
}

async function fetchText(url: string, timeoutMs = 5000): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function fetchService(
  domain: string,
  s: { endpoint: string; gatusBase: string },
): Promise<
  { endpoint: string; healthy: boolean | null; uptime30d: number | null; uptimeUrl: string }
> {
  const base = `https://${s.gatusBase}.${domain}`
  const healthUrl = `${base}/api/v1/endpoints/${s.endpoint}/health/badge.svg`
  const uptimeUrl = `${base}/api/v1/endpoints/${s.endpoint}/uptimes/30d/badge.svg`
  const detailUrl = `${base}/endpoints/${s.endpoint}`
  const [healthSvg, uptimeSvg] = await Promise.all([
    fetchText(healthUrl),
    fetchText(uptimeUrl),
  ])
  return {
    endpoint: s.endpoint,
    healthy: healthSvg ? parseHealthSvg(healthSvg) : null,
    uptime30d: uptimeSvg ? parseUptimeSvg(uptimeSvg) : null,
    uptimeUrl: detailUrl,
  }
}

function isDeployTempDir(): boolean {
  return Deno.cwd().includes("/deploy_")
}

async function main(): Promise<void> {
  const domain = Deno.env.get("DOMAIN")
  if (!domain) throw new Error("DOMAIN env var is required")

  // Determine which gatus server hosts the "main" uptime overview link in
  // the footer. Prefer home gatus for home-facing readers; fall back to
  // cloud if home's gatus is not configured (it always is in practice).
  const uptimeHost = Deno.env.get("UPTIME_HOST") ?? `uptime-cloud.${domain}`

  // 1. Render the template.
  const templateContent = await Deno.readTextFile(templateFile)
  const rendered = substituteEnvVars(
    templateContent
      .replace(/\${GENERATED_AT}/g, new Date().toISOString().replace(/\.\d+Z$/, "Z"))
      .replace(/\${UPTIME_HOST}/g, uptimeHost),
  )
  await Deno.writeTextFile(outputFile, rendered)
  console.log(`Generated '${outputFile}' from '${templateFile}'`)

  // 2. Fetch health data in parallel.
  console.log(`Fetching health for ${services.length} services from gatus...`)
  const results = await Promise.all(
    services.map((s) => fetchService(domain, s)),
  )
  const serviceMap: Record<string, unknown> = {}
  let healthyCount = 0
  let downCount = 0
  let unknownCount = 0
  for (const r of results) {
    serviceMap[r.endpoint] = {
      healthy: r.healthy,
      uptime30d: r.uptime30d,
      uptimeUrl: r.uptimeUrl,
    }
    if (r.healthy === true) healthyCount++
    else if (r.healthy === false) downCount++
    else unknownCount++
  }
  console.log(
    `Health: ${healthyCount} up, ${downCount} down, ${unknownCount} unknown`,
  )

  // 3. Write health.js as a plain JS file (no fetch round-trip on page load).
  const payload = JSON.stringify(
    { generatedAt: new Date().toISOString(), services: serviceMap },
    null,
    2,
  )
  await Deno.writeTextFile(
    healthFile,
    `// Auto-generated by before.deploy.ts. Do not edit.\n` +
      `window.__dashHealth = ${payload};\n`,
  )
  console.log(`Generated '${healthFile}'`)

  // 4. Drop the template from the deploy temp copy so it never reaches
  //    the nginx-served path.
  if (isDeployTempDir()) {
    await Deno.remove(templateFile)
    console.log("Removed template from deploy temp dir")
  }
}

try {
  await main()
} catch (error: unknown) {
  console.error(
    `An error occurred: ${error instanceof Error ? error.message : String(error)}`,
  )
  Deno.exit(1)
}
