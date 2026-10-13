// before.deploy.ts — writes the registry's login file before compose up.
//
// The registry reads its users from an htpasswd file and accepts bcrypt
// hashes only. This hook hashes DOCKER_REGISTRY_PASSWORD and writes
// `auth/htpasswd` next to compose.yml, which mounts that folder read-only.
// The plain password never reaches the server through this stack: only
// the hash is copied.
//
// Same approach as stacks/traefik/before.deploy.ts: `npm:bcryptjs` instead
// of the `htpasswd` binary, so the hook needs nothing on the deploying
// machine beyond Deno. Self-contained per the hook contract (no import out
// of this stack folder).
//
// compose.yml turns the login on unconditionally, so a missing user or
// password fails the deploy here instead of starting a registry nobody
// can sign in to.
//
// Paths are relative to the deploy staging folder, the hook's working
// directory.

import { hashSync } from "npm:bcryptjs@3.0.3"

const AUTH_DIR = "stacks/docker-registry/auth"
const HTPASSWD_PATH = `${AUTH_DIR}/htpasswd`

/**
 * The htpasswd line for the registry's one user, from DOCKER_REGISTRY_USER
 * and DOCKER_REGISTRY_PASSWORD. Pure, so every branch is testable without
 * the filesystem. Throws, naming the key, when one is missing, and when
 * the user name could not be read back from an htpasswd line.
 */
export function resolveHtpasswdLine(getEnv: (key: string) => string | undefined): string {
  const user = getEnv("DOCKER_REGISTRY_USER")
  const password = getEnv("DOCKER_REGISTRY_PASSWORD")
  if (!user) {
    throw new Error("DOCKER_REGISTRY_USER is not set. The registry needs a user to sign in as.")
  }
  if (!password) {
    throw new Error(
      "DOCKER_REGISTRY_PASSWORD is not set. Running `rostok stack add docker-registry` again " +
        "for this server generates one and keeps every value already there.",
    )
  }
  if (/[:\s]/.test(user)) {
    throw new Error("DOCKER_REGISTRY_USER must not contain a colon or whitespace.")
  }
  // Cost 10 is `htpasswd -B`'s default.
  return `${user}:${hashSync(password, 10)}\n`
}

if (import.meta.main) {
  try {
    const line = resolveHtpasswdLine((key) => Deno.env.get(key))
    await Deno.mkdir(AUTH_DIR, { recursive: true })
    // 0644: the file holds a bcrypt hash, not the password, and its owner
    // on the server is whoever copied it there, not the registry's user.
    await Deno.writeTextFile(HTPASSWD_PATH, line, { mode: 0o644 })
    console.log(`Generated ${HTPASSWD_PATH}`)
  } catch (err) {
    console.error("before.deploy.ts FAILED:", err instanceof Error ? err.message : String(err))
    Deno.exit(1)
  }
}
