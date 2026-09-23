// #207 deploy-side preflight: run before any file is synced. A wrong
// DOCKER_GROUP_ID leaves Traefik (and anything else that reaches
// /var/run/docker.sock via `group_add`) unable to read the socket — it
// reports healthy and answers 404 for every host, with the cause visible
// only in `docker logs`. Catching the mismatch here turns that into a
// clear deploy-time error instead.

import { UserError } from "../errors.ts"
import { runRemoteCommand } from "./exec.ts"

/**
 * `ssh <target> getent group docker`. Throws UserError if the docker
 * group is missing, or if its GID doesn't match `expectedGid` (naming
 * both values and `envPath` so the operator knows what to edit).
 */
export async function checkDockerGroup(
  sshAddress: string,
  expectedGid: string,
  envPath: string,
): Promise<void> {
  const result = await runRemoteCommand(sshAddress, ["getent", "group", "docker"])
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
      `DOCKER_GROUP_ID mismatch: ${envPath} has ${expectedGid}, but the docker group on ` +
        `${sshAddress} is ${remoteGid}. Update DOCKER_GROUP_ID in ${envPath} to ${remoteGid} ` +
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
  const uid = result.output.trim()
  if (!result.success || !uid) {
    throw new UserError(
      `could not determine the remote user's UID on ${sshAddress} (\`id -u\` failed: ` +
        `${result.error.trim()}).`,
    )
  }
  return uid !== "0"
}
