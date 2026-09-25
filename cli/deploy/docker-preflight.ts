// #207 deploy-side preflight: run before any file is synced. A wrong
// DOCKER_GROUP_ID leaves Traefik (and anything else that reaches
// /var/run/docker.sock via `group_add`) unable to read the socket — it
// reports healthy and answers 404 for every host, with the cause visible
// only in `docker logs`. Catching the mismatch here turns that into a
// clear deploy-time error instead.

import { UserError } from "../errors.ts"
import { pathComponents, pathsNestedOrEqual } from "../server-keys.ts"
import {
  type CommandResult,
  runRemoteCommand,
  runRemoteShell,
  shQuote,
  stripControlChars,
} from "./exec.ts"

/**
 * ssh's own connection-level failures (can't resolve/connect/reach the
 * host, timed out, refused, auth failed) always exit 255 — distinct
 * from a remote command that ran and returned its own nonzero exit.
 * Naming this here lets checkDockerGroup/needsRemoteSudo say "can't
 * reach the server" instead of misreporting an unreachable host as
 * "docker group not found" or "could not determine the UID".
 */
const SSH_CONNECTION_FAILURE_CODE = 255

function connectionFailureMessage(sshAddress: string, step: string, result: CommandResult): string {
  return `can't reach ${sshAddress} over SSH (${step}): ${
    result.error.trim() || "connection failed"
  }`
}

/**
 * `ssh <target> getent group docker`. Throws UserError if the docker
 * group is missing, or if its GID doesn't match `expectedGid` (naming
 * both values and `sourceFile` so the operator knows what to edit).
 *
 * `sourceFile` is the caller's job to get right: DOCKER_GROUP_ID can
 * legitimately live in either `.env.root` or the server `.env` (compose
 * reads both), so the caller passes whichever file the value actually
 * came from — not always the server `.env`.
 */
export async function checkDockerGroup(
  sshAddress: string,
  expectedGid: string,
  sourceFile: string,
): Promise<void> {
  const result = await runRemoteCommand(sshAddress, ["getent", "group", "docker"])
  if (result.code === SSH_CONNECTION_FAILURE_CODE) {
    throw new UserError(connectionFailureMessage(sshAddress, "checking the docker group", result))
  }
  const line = result.output.trim()
  if (!result.success || !line) {
    throw new UserError(
      `docker group not found on ${sshAddress} (\`getent group docker\` returned nothing). ` +
        `Install Docker on the server before deploying.`,
    )
  }
  // getent group format: name:password:GID:members
  const remoteGid = line.split(":")[2]
  if (!remoteGid) {
    throw new UserError(
      `could not parse the docker group GID from ${sshAddress} (got "${line}").`,
    )
  }
  if (remoteGid !== expectedGid) {
    throw new UserError(
      `DOCKER_GROUP_ID mismatch: ${sourceFile} has ${expectedGid}, but the docker group on ` +
        `${sshAddress} is ${remoteGid}. Update DOCKER_GROUP_ID in ${sourceFile} to ${remoteGid} ` +
        `and redeploy.`,
    )
  }
}

/**
 * `ssh <target> id -u` — decide whether privileged remote commands
 * (mkdir/chown for volume directories) need a `sudo -n` prefix. This is
 * decided from the remote itself, not from the SSH_USER string: an SSH
 * target of `root@host` logs in as root even when SSH_USER in `.env`
 * still names a non-root user (a stale value, an ssh_config alias with
 * its own `User root`, …), so trusting the string was wrong — it added
 * `sudo -n` for a session that was already root.
 */
export async function needsRemoteSudo(sshAddress: string): Promise<boolean> {
  const result = await runRemoteCommand(sshAddress, ["id", "-u"])
  if (result.code === SSH_CONNECTION_FAILURE_CODE) {
    throw new UserError(
      connectionFailureMessage(sshAddress, "checking the remote user's UID", result),
    )
  }
  const uid = result.output.trim()
  if (!result.success || !uid) {
    throw new UserError(
      `could not determine the remote user's UID on ${sshAddress} (\`id -u\` failed: ` +
        `${result.error.trim()}).`,
    )
  }
  return uid !== "0"
}

/**
 * `ssh <target> mkdir -p <PATH_APPS> <VOLUMES_PATH> <PATH_APPS>/stacks;
 * readlink -f` each of the three — refuses to proceed (nothing
 * deleted, ever) if PATH_APPS and VOLUMES_PATH resolve to nested or
 * equal real paths, OR if `PATH_APPS/stacks` doesn't resolve to exactly
 * `<resolved PATH_APPS>/stacks` (review round: a `stacks/` folder
 * itself replaced with a symlink into VOLUMES_PATH passed the first
 * check — PATH_APPS and VOLUMES_PATH themselves were still siblings —
 * while every later `rm`/`docker compose down` under it actually
 * reached VOLUMES_PATH/<stack>, still printing "Data kept"). Run
 * BEFORE any deletion (the stale-stack cleanup, or a `rsync --delete`)
 * — `env.ts`'s own `pathsNestedOrEqual` check only ever sees the
 * strings in `.env`, which can't catch a symlink the operator (or an
 * attacker with prior remote access) put in place ON the server
 * itself.
 *
 * The `mkdir -p` first is required, not optional (review round):
 * `readlink -f` (GNU and BusyBox alike, verified directly) exits 1 —
 * no output at all — the moment any component BEFORE the last is
 * missing; only a fresh server would ever hit that, exactly the case
 * this guard must not block. `mkdir -p` only ever CREATES directories
 * — it deletes nothing, so running it before the resolve-and-compare
 * below is safe on both a fresh server and an existing one (a no-op
 * there). `readlink -m` isn't used instead: BusyBox's `readlink` has
 * no `-m`.
 */
/**
 * The script body for `checkRemotePathsNotNested`, extracted as a pure
 * function so a test can run it directly through a REAL `sh` against a
 * real temp directory tree (never a fake) — the whole point is proving
 * it doesn't fail on a fresh server whose parent directories don't
 * exist yet, which a mocked `runRemoteShell` can't demonstrate either
 * way.
 */
export function buildPathsCheckScript(
  pathApps: string,
  volumesPath: string,
  needsSudo = false,
): string {
  const stacksDir = `${pathApps}/stacks`
  const quotedVolumesPath = shQuote(volumesPath)
  // VOLUMES_PATH gets `sudo -n` like volumes.ts's own mkdir of the same
  // tree: its parent is often root-owned (/srv). PATH_APPS never does,
  // since rsync writes there as the deploy user anyway.
  //
  // #243: only actually ESCALATE when the directory is still missing.
  // `sudo -n mkdir -p` used to run unconditionally whenever needsSudo
  // was true, even though `mkdir -p` on an existing directory is a
  // no-op — a non-root deploy user without passwordless sudo, but whose
  // VOLUMES_PATH the operator had already created (or who owns it
  // directly), could no longer deploy at all, even though nothing here
  // actually needed to create anything. `[ -d X ] ||` only reaches
  // `sudo -n mkdir` when the directory doesn't already exist.
  // Wrapped in a subshell `( ... )`, not left as a bare
  // `cmd1 && [ -d X ] || sudo ... && cmd4` chain: `&&`/`||` share one
  // precedence level and associate left to right, so an un-grouped
  // `A && B || C && D` parses as `((A && B) || C) && D` — a FAILED `A`
  // would still let `C` (the sudo mkdir) run, since `false || C`
  // reduces to `C` regardless of `A`. The subshell's own exit status is
  // `[ -d X ] || sudo ...`'s result, so the surrounding `&&` chain sees
  // one command and short-circuits correctly on every earlier failure.
  const volumesMkdir = needsSudo
    ? `( [ -d ${quotedVolumesPath} ] || sudo -n mkdir -p -- ${quotedVolumesPath} )`
    : `mkdir -p -- ${quotedVolumesPath}`
  // A single script STRING (runRemoteShell), never several argv
  // elements handed to runRemoteCommand — ssh joins trailing argv with
  // plain spaces before sending it to the remote shell, which would
  // reparse (and break) a multi-word command built that way; every
  // other multi-step remote script in cli/deploy/ already goes through
  // runRemoteShell for the same reason.
  // One `readlink -f` per line; the caller requires exactly three
  // lines, so a resolved path that itself holds a newline is refused.
  // `&&` throughout, never `;` — a failed mkdir (sudo denied, disk full)
  // must stop the script right there instead of feeding a nonexistent
  // path to `readlink -f` and reporting a confusing resolve failure
  // instead of the real mkdir error.
  return `mkdir -p -- ${shQuote(pathApps)} ${shQuote(stacksDir)} && ` +
    `${volumesMkdir} && ` +
    `readlink -f -- ${shQuote(pathApps)} && ` +
    `readlink -f -- ${quotedVolumesPath} && ` +
    `readlink -f -- ${shQuote(stacksDir)}`
}

export async function checkRemotePathsNotNested(
  sshAddress: string,
  pathApps: string,
  volumesPath: string,
  needsSudo = false,
): Promise<void> {
  const stacksDir = `${pathApps}/stacks`
  const script = buildPathsCheckScript(pathApps, volumesPath, needsSudo)
  const result = await runRemoteShell(sshAddress, script)
  if (result.code === SSH_CONNECTION_FAILURE_CODE) {
    throw new UserError(
      connectionFailureMessage(sshAddress, "resolving PATH_APPS/VOLUMES_PATH symlinks", result),
    )
  }
  if (!result.success) {
    throw new UserError(
      `could not prepare/resolve PATH_APPS "${pathApps}" or VOLUMES_PATH "${volumesPath}" on ` +
        `${sshAddress} (\`mkdir -p\`/\`readlink -f\` failed): ${result.error.trim()}`,
    )
  }
  const lines = result.output.replace(/\n$/, "").split("\n")
  const [realPathApps, realVolumesPath, realStacksDir] = lines
  if (lines.length !== 3 || lines.some((l) => !l.startsWith("/"))) {
    throw new UserError(
      `could not resolve PATH_APPS "${pathApps}" or VOLUMES_PATH "${volumesPath}" on ` +
        `${sshAddress} — \`readlink -f\` didn't return exactly one absolute path for each.`,
    )
  }
  // The three resolved paths came back from the server itself
  // (`readlink -f`) — anyone with write access there (a symlink target
  // name, in particular) can shape one into terminal escape sequences.
  // Stripped before they ever reach a refusal message printed to the
  // operator's terminal.
  const cleanPathApps = stripControlChars(realPathApps)
  const cleanVolumesPath = stripControlChars(realVolumesPath)
  const cleanStacksDir = stripControlChars(realStacksDir)
  if (pathsNestedOrEqual(realPathApps, realVolumesPath)) {
    throw new UserError(
      `on ${sshAddress}, PATH_APPS and VOLUMES_PATH resolve (readlink -f) to nested or equal ` +
        `real paths — PATH_APPS "${pathApps}" -> "${cleanPathApps}", VOLUMES_PATH ` +
        `"${volumesPath}" -> "${cleanVolumesPath}" — even though their .env values look like ` +
        `separate directories. A symlink on the server itself must be the cause; deploy ` +
        `refuses to sync or clean up anything until it's fixed, since a full deploy's ` +
        `rsync --delete would otherwise be able to reach VOLUMES_PATH's data.`,
    )
  }
  const expectedStacksComponents = [...pathComponents(realPathApps), "stacks"]
  const actualStacksComponents = pathComponents(realStacksDir)
  const stacksRedirected = expectedStacksComponents.length !== actualStacksComponents.length ||
    expectedStacksComponents.some((c, i) => c !== actualStacksComponents[i])
  if (stacksRedirected) {
    throw new UserError(
      `on ${sshAddress}, PATH_APPS/stacks doesn't resolve to PATH_APPS's own stacks directory ` +
        `— "${stacksDir}" -> "${cleanStacksDir}", but PATH_APPS itself -> "${cleanPathApps}" ` +
        `(expected "${cleanPathApps}/stacks"). A symlink replacing the stacks/ folder itself ` +
        `must be the cause — every stale-stack removal and per-stack sync runs under this ` +
        `path, so this must be fixed before deploy touches anything.`,
    )
  }
}
