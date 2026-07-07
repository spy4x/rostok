// Copies server-specific Traefik dynamic config files into the dynamic/
// directory before deployment. This allows per-server overrides (e.g.,
// authelia middleware + opencode-web route on home) while keeping a shared
// base config (00-base.yml) used by all servers.
//
// Also generates .htpasswd file for dashboard-auth from env vars, avoiding
// bcrypt $ escaping issues with YAML/Docker Compose interpolation.
//
// Expected file location on server:
//   configs/traefik/dynamic/*.yml  →  stacks/traefik/dynamic/*.yml

const DYNAMIC_DIR = "stacks/traefik/dynamic"
const configSource = "configs/traefik/dynamic"

/**
 * Generate .htpasswd file from BASIC_AUTH_USER and BASIC_AUTH_PASSWORD env vars.
 * Writes to dynamic/ so it's mounted into Traefik at /etc/traefik/dynamic/.htpasswd.
 */
async function generateHtpasswd(): Promise<void> {
  const user = Deno.env.get("BASIC_AUTH_USER")
  const password = Deno.env.get("BASIC_AUTH_PASSWORD")

  if (!user || !password) {
    console.log("BASIC_AUTH_USER or BASIC_AUTH_PASSWORD not set, skipping htpasswd generation")
    return
  }

  const htpasswdPath = `${DYNAMIC_DIR}/.htpasswd`
  const content = `${user}:${password}\n`
  await Deno.writeTextFile(htpasswdPath, content, { mode: 0o600 })
  console.log(`Generated ${htpasswdPath}`)
}

// Copy server-specific config if present
try {
  const entries: Deno.DirEntry[] = []
  for await (const entry of Deno.readDir(configSource)) {
    entries.push(entry)
  }

  if (entries.length > 0) {
    const destDir = DYNAMIC_DIR
    for (const entry of entries) {
      if (entry.isFile && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))) {
        const destPath = `${destDir}/${entry.name}`
        await Deno.copyFile(`${configSource}/${entry.name}`, destPath)
        console.log(`Copied ${configSource}/${entry.name} → ${destPath}`)
      }
    }
  } else {
    console.log(`No server-specific Traefik configs found in ${configSource}`)
  }
} catch (err) {
  if (err instanceof Deno.errors.NotFound) {
    console.log(`No server-specific Traefik configs (${configSource} not found)`)
  } else {
    throw err
  }
}

// Generate htpasswd after all configs are copied
await generateHtpasswd()
