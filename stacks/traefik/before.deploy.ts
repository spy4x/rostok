// Copies server-specific Traefik dynamic config files into the dynamic/
// directory before deployment. This allows per-server overrides (e.g.,
// authelia middleware + opencode-web route on home) while keeping a shared
// base config (00-base.yml) used by all servers.
//
// Also generates .htpasswd for dashboard-auth by bcrypt-hashing
// TRAEFIK_BASIC_AUTH_PASSWORD. Uses `npm:bcryptjs` instead of the
// `htpasswd` binary so the hook needs nothing on the user's machine beyond
// Deno itself — the hook contract runs this file standalone (see
// stacks/traefik/README.md and docs/design/v1-cli.md), no relative import
// out of this stack directory.
//
// Traefik's basicAuth middleware caches the file at startup — the
// after.deploy.ts hook restarts hl-traefik after deploy so it picks up
// the new file.
//
// Expected file location on server:
//   configs/traefik/dynamic/*.yml  →  stacks/traefik/dynamic/*.yml

import { hashSync } from "npm:bcryptjs@3.0.3"

const DYNAMIC_DIR = "stacks/traefik/dynamic"
const HTPASSWD_PATH = `${DYNAMIC_DIR}/.htpasswd`
const configSource = "configs/traefik/dynamic"

/**
 * bcrypt-hash `password`. Cost 10 matches `htpasswd -B`'s default and is
 * what this replaces. Exported so it's testable against bcryptjs's own
 * `compareSync` without running the hook.
 */
export function hashPassword(password: string): string {
  return hashSync(password, 10)
}

async function writeHtpasswd(user: string, hash: string): Promise<void> {
  await Deno.writeTextFile(HTPASSWD_PATH, `${user}:${hash}\n`, { mode: 0o600 })
}

/**
 * Generate .htpasswd for dashboard-auth from TRAEFIK_BASIC_AUTH_USER +
 * TRAEFIK_BASIC_AUTH_PASSWORD (bcrypt-hashed here). Falls back to the
 * pre-#210 legacy inputs — BASIC_AUTH_USER with either BASIC_AUTH_BASE64
 * ("user:pass" base64) or an already-hashed BASIC_AUTH_PASSWORD — for
 * servers whose .env hasn't been migrated to the new key names yet.
 */
async function generateHtpasswd(): Promise<void> {
  const user = Deno.env.get("TRAEFIK_BASIC_AUTH_USER")
  const password = Deno.env.get("TRAEFIK_BASIC_AUTH_PASSWORD")

  if (user && password) {
    await writeHtpasswd(user, hashPassword(password))
    console.log(`Generated ${HTPASSWD_PATH} (bcrypt from TRAEFIK_BASIC_AUTH_PASSWORD)`)
    return
  }

  // Legacy fallback (pre-#210 servers/*/.env).
  const legacyUser = Deno.env.get("BASIC_AUTH_USER")
  if (!legacyUser) {
    console.log(
      "No TRAEFIK_BASIC_AUTH_USER/BASIC_AUTH_USER set, skipping htpasswd generation",
    )
    return
  }

  const base64Auth = Deno.env.get("BASIC_AUTH_BASE64")
  if (base64Auth) {
    try {
      const decoded = atob(base64Auth)
      const colonIdx = decoded.indexOf(":")
      const plainPassword = colonIdx > 0 ? decoded.substring(colonIdx + 1) : null
      if (plainPassword) {
        await writeHtpasswd(legacyUser, hashPassword(plainPassword))
        console.log(`Generated ${HTPASSWD_PATH} (bcrypt from legacy BASIC_AUTH_BASE64)`)
        return
      }
    } catch (err) {
      console.log(`Failed to decode BASIC_AUTH_BASE64: ${err}`)
    }
  }

  const legacyPassword = Deno.env.get("BASIC_AUTH_PASSWORD")
  if (legacyPassword?.startsWith("$2")) {
    // Already a bcrypt hash — write it directly.
    await writeHtpasswd(legacyUser, legacyPassword)
    console.log(`Generated ${HTPASSWD_PATH} (legacy bcrypt from BASIC_AUTH_PASSWORD)`)
    return
  }
  if (legacyPassword) {
    await writeHtpasswd(legacyUser, hashPassword(legacyPassword))
    console.log(`Generated ${HTPASSWD_PATH} (bcrypt from legacy plaintext BASIC_AUTH_PASSWORD)`)
    return
  }

  console.log(
    "No password source found (set TRAEFIK_BASIC_AUTH_PASSWORD, or legacy BASIC_AUTH_BASE64/BASIC_AUTH_PASSWORD)",
  )
}

async function copyServerConfigs(): Promise<void> {
  try {
    const entries: Deno.DirEntry[] = []
    for await (const entry of Deno.readDir(configSource)) {
      entries.push(entry)
    }

    if (entries.length > 0) {
      for (const entry of entries) {
        if (entry.isFile && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))) {
          const destPath = `${DYNAMIC_DIR}/${entry.name}`
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
}

if (import.meta.main) {
  await copyServerConfigs()
  await generateHtpasswd()
}
