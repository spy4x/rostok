// Builds and parses the remote `docker compose` script deploy runs over
// a single SSH session. Ported from the old scripts/deploy/src/+lib.ts —
// every value that comes from `.env`/`config.json` (PATH_APPS, a stack
// name, deployAs) is now quoted with `shQuote` (single quotes) before
// going into the script. The old double-quoting (`cd "${pathApps}"`)
// still let `$(...)`/backticks run inside it and broke outright on an
// embedded `"` — single quotes suppress both.

import { runRemoteShell, shQuote, stripControlChars } from "./exec.ts"

export interface StackConfig {
  name: string
  deployAs?: string
  envs?: Record<string, string>
  watchFilesAndRestartIfChanged?: string[]
}

export interface DeployResult {
  name: string
  deployAs: string
  success: boolean
  error?: string
  /**
   * True when `docker compose up -d` succeeded and the stack failed the look
   * at its containers afterwards. `error` is then the report of that look:
   * each failed container with its last log lines.
   */
  containerFailed?: boolean
}

/**
 * Seconds between the last stack's `up -d` and the look at every stack's
 * containers. One wait per deploy, not per stack, and none when no stack
 * has a container.
 */
export const VERIFY_WAIT_SECONDS = 5

/** How many of a failed container's last log lines the deploy prints. */
export const VERIFY_LOG_LINES = 20

/** Shell function that prints one line per container of a compose project. */
const CONTAINERS_FN = "rostok_containers"

/** Shell variable that is set once a started stack has a container to look at. */
const VERIFY_WAIT_VAR = "rostok_verify_wait"

/**
 * Defines the shell function `rostok_containers <project>`: one line per
 * container of the compose project, `id|name|status|exit code|restart
 * count|finished at`. A `while read` loop rather than one `docker inspect`
 * over all IDs: the remote login shell can be zsh, which does not split an
 * unquoted expansion into words.
 */
const VERIFY_PREAMBLE = `
${CONTAINERS_FN}() {
  docker ps -a -q --filter "label=com.docker.compose.project=\$1" 2>/dev/null | while read -r rostok_id; do
    [ -n "\$rostok_id" ] || continue
    docker inspect --format '{{.Id}}|{{.Name}}|{{.State.Status}}|{{.State.ExitCode}}|{{.RestartCount}}|{{.State.FinishedAt}}' "\$rostok_id" 2>/dev/null
  done
}
${VERIFY_WAIT_VAR}=
`

/** Shell variable holding the stack's container names, one per line. */
const STALE_NAMES_VAR = "rostok_container_names"

/**
 * Prints each service's `container_name` from `docker compose config` YAML,
 * one per line, with the quotes compose adds to a numeric- or boolean-looking
 * value stripped: double quotes up to Compose 5.0, single quotes for
 * boolean-looking names on 5.5 (a container name can never contain a
 * quote). Only keys directly under a service in the top-level `services:`
 * block count.
 */
const CONTAINER_NAMES_AWK = [
  `/^[^ ]/ { svc = ($0 == "services:") }`,
  `svc && /^    container_name: / { v = $2; gsub(/["']/, "", v); print v }`,
].join(" ")

/**
 * Generate a shell script that deploys all stacks in one SSH session and
 * prints structured `DEPLOY_START`/`DEPLOY_SUCCESS`/`DEPLOY_FAILED`
 * markers `parseDeployResults` reads back.
 *
 * It runs in two parts. The first starts every stack with `up -d`; a stack
 * whose `up` fails is marked failed there. The second waits
 * VERIFY_WAIT_SECONDS once and looks at the containers of every stack that
 * started (#383): `up -d` returns 0 as soon as the containers are created,
 * so a container that dies at start used to count as a success. A stack is
 * marked failed when one of its containers
 *
 * - is restarting at the look, or was restarted by Docker two or more
 *   times during the wait: a crash loop. One restart is not a failure: a
 *   service that exits once because its database is not up yet, and then
 *   stays up, is healthy. So a loop whose container runs longer than
 *   about two seconds between crashes, and is running at the look, is
 *   missed;
 * - has exited with a non-zero code since this stack's `up` began. An
 *   older exit is left alone: it is not this deploy's doing, and `up`
 *   leaves a container of a service that compose no longer lists as it is.
 *
 * The failed container's last VERIFY_LOG_LINES log lines follow, indented,
 * after a `DEPLOY_VERIFY` marker. A one-shot container that exited 0, and
 * one whose health check is still starting or failing, do not fail the
 * stack. A container that dies later than the wait is not seen.
 */
export function generateDeployScript(
  stacks: StackConfig[],
  pathApps: string,
  restartStacks: Set<string>,
): string {
  const stackCommands: string[] = [VERIFY_PREAMBLE]
  const verifyCommands: string[] = []

  for (const [index, stackConfig] of stacks.entries()) {
    const upVar = `rostok_up_${index}`
    const startedVar = `rostok_started_${index}`
    const beforeVar = `rostok_before_${index}`
    const stackName = stackConfig.name
    const deployAs = stackConfig.deployAs || stackName
    const projectFlag = `-p ${shQuote(deployAs)}`
    const needsRestart = restartStacks.has(deployAs)
    const quotedPathApps = shQuote(pathApps)
    const startMarker = shQuote(`DEPLOY_START:${stackName}:${deployAs}`)
    const successMarker = shQuote(`DEPLOY_SUCCESS:${stackName}:${deployAs}`)
    const failedMarker = shQuote(`DEPLOY_FAILED:${stackName}:${deployAs}`)
    const verifyMarker = shQuote(`DEPLOY_VERIFY:${stackName}:${deployAs}`)
    const restartingMarker = shQuote(`RESTARTING:${stackName}:${deployAs}`)
    const restartDoneMarker = shQuote(`RESTART_DONE:${stackName}:${deployAs}`)

    stackCommands.push(`
echo ${startMarker}
# Per-server compose override (if present). The deploy rsyncs
# servers/<server>/compose-override/ to <pathApps>/compose-override/, so that
# is the path to test here — not servers/<server>/, which does not exist on
# the remote.
#
# Args are built with set --/"\$@" rather than a plain string. The remote
# login shell is zsh, which does NOT word-split unquoted parameter
# expansions, so \$COMPOSE_FILES arrived as ONE argument and docker compose
# read the filename as " stacks/<stack>/compose.yml" — leading space and all.
set -- -f ${shQuote(`stacks/${stackName}/compose.yml`)}
[ -f ${shQuote(`${pathApps}/compose-override/${stackName}.yml`)} ] && set -- "\$@" -f ${
      shQuote(`compose-override/${stackName}.yml`)
    }
# Belt-and-braces: drop any existing container with one of the stack's
# container_names that doesn't belong to the current compose project. Happens
# when a stack was previously deployed with a different project name (e.g.
# manual \`docker compose up\` that picked up \`name: \${PROJECT}\` from
# compose.yml, producing project=hl, vs the deploy script's -p ${deployAs}
# producing project=${deployAs}). Same container_name under two different
# projects → "name already in use" conflict on every redeploy.
# Data lives in volumes, not in the container, so this is safe.
#
# The names come from \`docker compose config\` with the same env files, -p
# and -f as \`up\` below, so a container_name set from a variable (nginx
# deployed as another project with NGINX_CONTAINER_NAME) resolves to exactly
# the name \`up\` would create. Only an exact name match is removed: Docker's
# \`--filter name=\` matches substrings, so deploying foo used to remove
# hl-foo-bar of another project too (#304). A matching name alone is not
# enough either: the container must carry a compose project label and have
# been created from this stack's own compose file, so a wrong
# NGINX_CONTAINER_NAME=hl-traefik can't remove Traefik, and a container
# compose doesn't manage is never touched. \`up\` then fails on the name
# conflict instead, which is the safe way round.
${STALE_NAMES_VAR}=\$(cd ${quotedPathApps} && docker compose ${projectFlag} --env-file=.env.root --env-file=.env "\$@" config 2>/dev/null | awk ${
      shQuote(CONTAINER_NAMES_AWK)
    })
docker ps -a --format '{{.Names}}|{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.config_files"}}' 2>/dev/null | while IFS='|' read -r cname id proj files; do
  printf '%s\\n' "\$${STALE_NAMES_VAR}" | grep -qxF -- "\$cname" || continue
  [ "\$proj" != ${shQuote(deployAs)} ] && [ -n "\$id" ] || continue
  case ",\$files," in
    *${shQuote(`/stacks/${stackName}/compose.yml,`)}*) own=1 ;;
    *) own= ;;
  esac
  if [ -n "\$proj" ] && [ -n "\$own" ]; then
    printf '  removing stale container %s (project=%s, expected=%s)\\n' "\$cname" "\$proj" ${
      shQuote(deployAs)
    }
    docker rm -f "\$id" >/dev/null 2>&1 || true
  else
    printf '  keeping container %s: it has this stack'"'"'s name but was not created from stacks/%s/compose.yml (project=%s)\\n' "\$cname" ${
      shQuote(stackName)
    } "\$proj"
  fi
done
${startedVar}=\$(date -u +%Y-%m-%dT%H:%M:%S)
cd ${quotedPathApps} && docker compose ${projectFlag} --env-file=.env.root --env-file=.env "\$@" up -d --build 2>&1
if [ $? -eq 0 ]; then
  ${upVar}=1
else
  ${upVar}=
  echo ${failedMarker}
fi
${
      needsRestart
        ? `
echo ${restartingMarker}
cd ${quotedPathApps} && docker compose ${projectFlag} "\$@" restart 2>&1
echo ${restartDoneMarker}
`
        : ""
    }
# The restart counts to compare with after the wait, taken after the restart above.
if [ -n "\$${upVar}" ]; then
  ${beforeVar}=\$(${CONTAINERS_FN} ${shQuote(deployAs)})
  if [ -n "\$${beforeVar}" ]; then ${VERIFY_WAIT_VAR}=1; fi
fi
`)

    // Every variable is prefixed: zsh, a possible remote login shell, keeps
    // `status` and others for itself. The loop runs in a subshell, so what
    // it finds comes back as its output.
    verifyCommands.push(`
if [ -n "\$${upVar}" ]; then
  echo ${verifyMarker}
  rostok_report=\$(${CONTAINERS_FN} ${
      shQuote(deployAs)
    } | while IFS='|' read -r rostok_id rostok_name rostok_status rostok_code rostok_restarts rostok_finished; do
    rostok_reason=
    case "\$rostok_status" in
      restarting) rostok_reason='is restarting' ;;
      exited|dead)
        if [ "\$rostok_code" != 0 ] && LC_ALL=C expr "x\$rostok_finished" '>=' "x\$${startedVar}" >/dev/null; then
          rostok_reason="exited with code \$rostok_code"
        fi ;;
    esac
    if [ -z "\$rostok_reason" ]; then
      rostok_was=\$(printf '%s\\n' "\$${beforeVar}" | awk -F'|' -v id="\$rostok_id" '\$1 == id { print \$5 }')
      if [ -n "\$rostok_was" ] && [ "\$rostok_restarts" -ge "\$((rostok_was + 2))" ] 2>/dev/null; then
        rostok_reason='keeps restarting'
      fi
    fi
    [ -n "\$rostok_reason" ] || continue
    printf 'Container %s %s. Its last log lines:\\n' "\${rostok_name#/}" "\$rostok_reason"
    docker logs --tail ${VERIFY_LOG_LINES} "\$rostok_id" 2>&1 | sed 's/^/  /'
  done)
  if [ -n "\$rostok_report" ]; then
    printf '%s\\n' "\$rostok_report"
    echo ${failedMarker}
  else
    echo ${successMarker}
  fi
fi
`)
  }

  return [
    ...stackCommands,
    `if [ -n "\$${VERIFY_WAIT_VAR}" ]; then sleep ${VERIFY_WAIT_SECONDS}; fi`,
    ...verifyCommands,
  ].join("\n")
}

/**
 * Parse the deploy output to extract results for each stack. A marker
 * counts only at the start of a line: the log lines of a failed container
 * are printed into the same output, indented, and must not be read as one.
 */
export function parseDeployResults(output: string, stacks: StackConfig[]): DeployResult[] {
  const results: DeployResult[] = []
  const lines = output.split("\n")

  for (const stackConfig of stacks) {
    const stackName = stackConfig.name
    const deployAs = stackConfig.deployAs || stackName

    const startMarker = `DEPLOY_START:${stackName}:${deployAs}`
    const successMarker = `DEPLOY_SUCCESS:${stackName}:${deployAs}`
    const failedMarker = `DEPLOY_FAILED:${stackName}:${deployAs}`
    const verifyMarker = `DEPLOY_VERIFY:${stackName}:${deployAs}`

    const isSuccess = lines.some((line) => line.startsWith(successMarker))
    const endIdx = lines.findIndex((line) => line.startsWith(failedMarker))
    const isFailed = endIdx !== -1

    // The error is what the stack printed last before it failed: the
    // report on its containers when `up` had succeeded, else `up`'s output.
    let errorOutput = ""
    let containerFailed = false
    if (isFailed) {
      const before = lines.slice(0, endIdx)
      const verifyIdx = before.findLastIndex((line) => line.startsWith(verifyMarker))
      containerFailed = verifyIdx !== -1
      const startIdx = containerFailed
        ? verifyIdx
        : before.findLastIndex((line) => line.startsWith(startMarker))
      if (startIdx !== -1) {
        errorOutput = before.slice(startIdx + 1).join("\n")
      }
    }

    results.push({
      name: stackName,
      deployAs,
      success: isSuccess && !isFailed,
      error: isFailed ? errorOutput : undefined,
      ...(containerFailed ? { containerFailed } : {}),
    })
  }

  return results
}

/** Print a summary of deployment results. */
export function printDeploySummary(results: DeployResult[]): void {
  console.log("\n========== DEPLOYMENT SUMMARY ==========")

  const successful = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)

  if (successful.length > 0) {
    console.log(`\n✅ Successful (${successful.length}/${results.length}):`)
    for (const result of successful) {
      const displayName = result.deployAs !== result.name
        ? `${result.name} (as ${result.deployAs})`
        : result.name
      console.log(`   ✓ ${displayName}`)
    }
  }

  if (failed.length > 0) {
    console.log(`\n❌ Failed (${failed.length}/${results.length}):`)
    for (const result of failed) {
      const displayName = result.deployAs !== result.name
        ? `${result.name} (as ${result.deployAs})`
        : result.name
      console.log(`   ✗ ${displayName}`)
      if (result.error && result.containerFailed) {
        // Printed whole: the container's last log lines are how the owner
        // learns why it died. Container logs can carry escape sequences too.
        console.log("     Started, then failed:")
        for (const line of stripControlChars(result.error).split("\n")) {
          console.log(`     ${line}`)
        }
      } else if (result.error) {
        // The error is raw `docker compose` output from the server, so
        // anyone there could plant terminal escape sequences in it (#250).
        const error = stripControlChars(result.error)
        console.log(`     Error: ${error.substring(0, 200)}${error.length > 200 ? "..." : ""}`)
      }
    }
  }

  console.log("\n=========================================")
  console.log(`Total: ${results.length} | Success: ${successful.length} | Failed: ${failed.length}`)
}

/**
 * Compute SHA256 checksums of config files on the remote server.
 * Returns a map of file path (relative to PATH_APPS) to checksum.
 */
export async function getRemoteChecksums(
  sshAddress: string,
  pathApps: string,
  watchFilesAndRestartIfChanged: string[],
): Promise<Map<string, string>> {
  const checksums = new Map<string, string>()

  for (const filePath of watchFilesAndRestartIfChanged) {
    const remotePath = `${pathApps}/${filePath}`
    const result = await runRemoteShell(
      sshAddress,
      `sha256sum ${shQuote(remotePath)} 2>/dev/null || true`,
    )

    if (result.success && result.output) {
      const hash = result.output.split(/\s+/)[0]
      if (hash && hash.length === 64) {
        checksums.set(filePath, hash)
      }
    }
  }

  return checksums
}
