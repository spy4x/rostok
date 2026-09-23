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
// dynamic/00-base.yml points dashboard-auth at .htpasswd unconditionally,
// so a missing credential fails the deploy (exit 1) instead of logging
// and continuing — a green deploy with no .htpasswd would ship a
// dashboard nothing can log into.
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

export interface HtpasswdCredential {
  user: string
  /** A bcrypt hash — already hashed by the caller, written verbatim. */
  hash: string
}

/**
 * Resolve the .htpasswd entry to write, from TRAEFIK_BASIC_AUTH_USER +
 * TRAEFIK_BASIC_AUTH_PASSWORD. Pure — no I/O — so every branch is
 * testable without touching the filesystem.
 *
 * Throws, naming exactly which key is missing, instead of returning
 * null: dynamic/00-base.yml points dashboard-auth at .htpasswd
 * unconditionally, so a deploy that skips writing it would go green
 * and still ship a dashboard nothing can log into.
 */
export function resolveHtpasswdCredential(
  getEnv: (key: string) => string | undefined,
): HtpasswdCredential {
  const user = getEnv("TRAEFIK_BASIC_AUTH_USER")
  const password = getEnv("TRAEFIK_BASIC_AUTH_PASSWORD")

  if (user && password) {
    return { user, hash: hashPassword(password) }
  }
  if (user && !password) {
    throw new Error(
      "TRAEFIK_BASIC_AUTH_USER is set but TRAEFIK_BASIC_AUTH_PASSWORD is not — both are required.",
    )
  }
  if (!user && password) {
    throw new Error(
      "TRAEFIK_BASIC_AUTH_PASSWORD is set but TRAEFIK_BASIC_AUTH_USER is not — both are required.",
    )
  }

  throw new Error(
    "No basic-auth credentials set: TRAEFIK_BASIC_AUTH_USER/TRAEFIK_BASIC_AUTH_PASSWORD are unset.",
  )
}

async function writeHtpasswd(user: string, hash: string): Promise<void> {
  // 0644, not 0600: the file holds a bcrypt hash, not the password
  // itself, and Traefik on the server runs as PUID:PGID — an owner
  // decided by the local uid that rsync'd the file, not necessarily
  // PUID. 0600 would leave the running container unable to read its
  // own dashboard-auth file.
  await Deno.writeTextFile(HTPASSWD_PATH, `${user}:${hash}\n`, { mode: 0o644 })
}

async function generateHtpasswd(): Promise<void> {
  const credential = resolveHtpasswdCredential((key) => Deno.env.get(key))
  await writeHtpasswd(credential.user, credential.hash)
  console.log(`Generated ${HTPASSWD_PATH}`)
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
  try {
    await copyServerConfigs()
    await generateHtpasswd()
  } catch (err) {
    console.error("before.deploy.ts FAILED:", err instanceof Error ? err.message : String(err))
    Deno.exit(1)
  }
}
