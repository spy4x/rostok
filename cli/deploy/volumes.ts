// Volume-directory provisioning (#206 deploy side).
//
// `generateVolumeCreationScript` used to chown to a user *name* and
// swallow failures (`|| true`, `2>/dev/null`) — a `chown` failure left
// directories owned by `root`, Traefik couldn't write `acme.json`, and
// deploy still printed "Volume directories created". It now chowns to
// `PUID:PGID` (the IDs the containers actually run as) and fails the
// deploy loudly, with the remote error, when mkdir or chown fails. When
// SSH_USER isn't root, every command is prefixed with `sudo -n` — a
// missing passwordless-sudo rule then surfaces as a clear deploy error
// instead of a silent permission failure.

/** Extract every `${VOLUMES_PATH}/...` reference from a set of compose files. */
export function extractVolumePaths(
  composeContents: string[],
  env: Record<string, string>,
): string[] {
  const volumePaths: Set<string> = new Set()

  for (const content of composeContents) {
    const volumeMatches = content.matchAll(/\$\{VOLUMES_PATH\}\/([^:]+):/g)

    for (const match of volumeMatches) {
      const volumeSubPath = match[1].split(":")[0]
      const expandedPath = volumeSubPath.replace(/\$\{([^}]+)\}/g, (_m, varName) => {
        return env[varName.trim()] || `\${${varName}}`
      })
      volumePaths.add(`${env["VOLUMES_PATH"] || "${VOLUMES_PATH}"}/${expandedPath}`)
    }
  }

  return Array.from(volumePaths)
}

/**
 * Build the remote script that creates and chowns every volume path to
 * `puid:pgid`. Every command is quoted, joined with `&&` (no
 * `|| true`/`2>/dev/null`), so any failure fails the whole script and
 * its stderr reaches the caller.
 */
export function generateVolumeCreationScript(
  volumePaths: string[],
  puid: string,
  pgid: string,
  sshUser: string,
): string {
  const sudo = sshUser === "root" ? "" : "sudo -n "
  const commands = volumePaths.map((path) => {
    return `${sudo}mkdir -p "${path}" && ${sudo}chown -R ${puid}:${pgid} "${path}"`
  })
  return commands.join(" && ")
}
