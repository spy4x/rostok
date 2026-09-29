// Guards that only a local server (SSH_ADDRESS=local, #282) needs.
//
// Over ssh, PATH_APPS and VOLUMES_PATH live on another machine, and the
// server's own Docker daemon is the only one in reach. On the machine
// rostok runs on, neither holds:
//
//   - A full deploy syncs PATH_APPS with `rsync --delete`. Pointed at the
//     project itself (or a folder holding it, such as $HOME), that sync
//     erases the project's .git/ and servers/*/.env.age. VOLUMES_PATH
//     inside the project would put app data under the same sync.
//   - The shell rostok runs in can point Docker somewhere else entirely:
//     DOCKER_HOST, or a context chosen with `docker context use prod`
//     (stored in ~/.docker/config.json). A "local" deploy would then
//     start the stacks on that remote daemon.
//
// Both are refused before any file is synced or any container touched.

import { UserError } from "../errors.ts"
import { pathComponents, pathsNestedOrEqual } from "../server-keys.ts"
import { localStepEnv, runRemoteCommand, stripControlChars } from "./exec.ts"

/** True when `ancestor` is `path` itself or one of its parent directories. */
function isAncestorOrEqual(ancestor: string, path: string): boolean {
  const a = pathComponents(ancestor)
  const p = pathComponents(path)
  return a.length <= p.length && a.every((component, i) => component === p[i])
}

/**
 * Throw a UserError when a local server's PATH_APPS or VOLUMES_PATH
 * equals, contains or sits inside the project root, or when PATH_APPS
 * is $HOME or one of its parents. `projectRoots` takes every spelling
 * of the project directory the caller knows (as given and with symlinks
 * resolved), so a symlinked checkout can't slip past a string compare.
 */
export function checkLocalDeployPaths(opts: {
  projectRoots: string[]
  pathApps: string
  volumesPath: string
  home?: string
}): void {
  for (const root of opts.projectRoots) {
    for (const [key, value] of [["PATH_APPS", opts.pathApps], ["VOLUMES_PATH", opts.volumesPath]]) {
      if (pathsNestedOrEqual(value, root)) {
        throw new UserError(
          `${key} "${value}" overlaps the project folder "${root}" on this local server — a ` +
            `full deploy syncs PATH_APPS with rsync --delete and would erase the project's ` +
            `files (.git/, servers/*/.env.age). Point ${key} at a folder outside the project, ` +
            `e.g. /srv/apps and /srv/volumes.`,
        )
      }
    }
  }
  if (opts.home && isAncestorOrEqual(opts.pathApps, opts.home)) {
    throw new UserError(
      `PATH_APPS "${opts.pathApps}" is your home folder "${opts.home}" or one of its parents — ` +
        `a full deploy syncs PATH_APPS with rsync --delete and would erase everything else in ` +
        `it. Point PATH_APPS at a dedicated folder, e.g. /srv/apps.`,
    )
  }
}

/**
 * Why the Docker endpoint in effect is not this machine's daemon, or
 * undefined when it is. `dockerHost` is DOCKER_HOST as the deploy steps
 * see it; `contextEndpoint` is what `docker context inspect` reports
 * for the active context (it already reflects DOCKER_HOST and
 * DOCKER_CONTEXT), undefined when docker could not report one.
 */
export function localDockerEndpointProblem(
  dockerHost: string | undefined,
  contextEndpoint: string | undefined,
): string | undefined {
  if (dockerHost && !dockerHost.startsWith("unix://")) {
    return `DOCKER_HOST is "${dockerHost}", not a local unix socket`
  }
  if (contextEndpoint === undefined || contextEndpoint === "") {
    return "docker could not report the active context's endpoint (`docker context inspect`)"
  }
  if (!contextEndpoint.startsWith("unix://")) {
    return `the active docker context points at "${contextEndpoint}", not a local unix socket`
  }
  return undefined
}

/** Refuse a local deploy whose Docker endpoint is not a local unix socket — see the module comment. */
export async function checkLocalDockerEndpoint(sshAddress: string): Promise<void> {
  const dockerHost = localStepEnv(Deno.env.toObject()).DOCKER_HOST
  const result = await runRemoteCommand(sshAddress, [
    "docker",
    "context",
    "inspect",
    "--format",
    "{{.Endpoints.docker.Host}}",
  ])
  const endpoint = result.success ? stripControlChars(result.output).trim() : undefined
  const problem = localDockerEndpointProblem(
    dockerHost === undefined ? undefined : stripControlChars(dockerHost),
    endpoint,
  )
  if (problem) {
    throw new UserError(
      `refusing to deploy the local server: ${problem}. A local server deploys to this ` +
        `machine's own Docker daemon; unset DOCKER_HOST or run \`docker context use default\`.`,
    )
  }
}
