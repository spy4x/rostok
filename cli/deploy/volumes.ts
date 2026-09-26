// Volume-directory provisioning (#206 deploy side).
//
// `generateVolumeCreationScript` used to chown to a user *name* and
// swallow failures (`|| true`, `2>/dev/null`) — a `chown` failure left
// directories owned by `root`, Traefik couldn't write `acme.json`, and
// deploy still printed "Volume directories created". It now chowns to
// `PUID:PGID` (the IDs the containers actually run as) and fails the
// deploy loudly, with the remote error, when mkdir or chown fails. The
// caller decides whether `sudo -n` is needed from the remote's actual
// `id -u` (see docker-preflight.ts's `needsRemoteSudo`), not from the
// SSH_USER string — `ssh root@host` logs in as root regardless of what
// SSH_USER says. A missing passwordless-sudo rule then surfaces as a
// clear deploy error instead of a silent permission failure.
//
// Every value below comes from `.env` or a compose file, so it's quoted
// with `shQuote` (single quotes) before going into the remote script —
// double quotes would still let `$(...)`/backticks run.
//
// (#249) A deploy user that isn't root runs `sudo -n` only for a folder
// that is missing or not owned by `PUID:PGID` yet. A folder that already
// exists with the right owner needs no change, so a user without
// passwordless sudo can still deploy a stack whose volume folders were
// prepared once by an admin.
//
// (#250) A volume path with a `..` component, or one that doesn't stay
// strictly inside VOLUMES_PATH, is refused: it would otherwise reach
// `sudo chown -R` and could take over any folder on the server, such as
// `/etc`.

import { shQuote } from "./exec.ts"
import { UserError } from "../errors.ts"
import { pathComponents } from "../server-keys.ts"

/**
 * Throw a UserError unless `path` is a real subfolder of `volumesPath`:
 * no `..` component anywhere, and inside `volumesPath` (never equal to
 * it) after normalising doubled slashes and `.` segments.
 */
function assertInsideVolumesPath(path: string, volumesPath: string): void {
  const components = path.split("/")
  if (components.includes("..")) {
    throw new UserError(
      `volume path "${path}" contains a ".." component — a compose volume must stay inside ` +
        `VOLUMES_PATH (${volumesPath}). Fix the stack's compose.yml or the variable it uses.`,
    )
  }
  const base = pathComponents(volumesPath)
  const target = pathComponents(path)
  const inside = target.length > base.length && base.every((c, i) => target[i] === c)
  if (!inside) {
    throw new UserError(
      `volume path "${path}" is not a subfolder of VOLUMES_PATH (${volumesPath}). ` +
        `Fix the stack's compose.yml or the variable it uses.`,
    )
  }
}

/**
 * Extract every `${VOLUMES_PATH}/...` reference from a set of compose
 * files. Throws a UserError for a path that would leave VOLUMES_PATH
 * (see `assertInsideVolumesPath`), before any command is built from it.
 */
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
      const volumesPath = env["VOLUMES_PATH"] || "${VOLUMES_PATH}"
      const fullPath = `${volumesPath}/${expandedPath}`
      assertInsideVolumesPath(fullPath, volumesPath)
      volumePaths.add(fullPath)
    }
  }

  return Array.from(volumePaths)
}

/**
 * Build the remote script that creates and chowns every volume path to
 * `puid:pgid`. Any failure fails the whole script and its stderr reaches
 * the caller: nothing is hidden behind `|| true` or `2>/dev/null`.
 *
 * As root (`needsSudo` false), every path gets `mkdir -p` and
 * `chown -R`, as before. Otherwise each path is wrapped as
 * `( [ -d P ] && [ "$(stat -c %u:%g P)" = U:G ] || { sudo -n mkdir -p -- P &&
 * sudo -n chown -R U:G -- P; } )`, so sudo runs only for a folder that
 * is missing or owned by someone else. The subshell keeps the `&&`
 * chain between paths intact: without it, `a && [ -d P ] || b && c`
 * would parse as `((a && [ -d P ]) || b) && c`, and a failure of `a`
 * would run `b` instead of stopping (the same reason #248 wrapped the
 * VOLUMES_PATH mkdir in docker-preflight.ts).
 */
export function generateVolumeCreationScript(
  volumePaths: string[],
  puid: string,
  pgid: string,
  needsSudo: boolean,
): string {
  const owner = `${shQuote(puid)}:${shQuote(pgid)}`
  const commands = volumePaths.map((path) => {
    const p = shQuote(path)
    if (!needsSudo) return `mkdir -p ${p} && chown -R ${owner} ${p}`
    return `( [ -d ${p} ] && [ "$(stat -c %u:%g -- ${p})" = ${owner} ] || ` +
      `{ sudo -n mkdir -p -- ${p} && sudo -n chown -R ${owner} -- ${p}; } )`
  })
  return commands.join(" && ")
}
