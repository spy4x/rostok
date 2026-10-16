// Builds and parses the remote `docker compose` script deploy runs over
// a single SSH session. Ported from the old scripts/deploy/src/+lib.ts —
// every value that comes from `.env`/`config.json` (PATH_APPS, a stack
// name, deployAs) is now quoted with `shQuote` (single quotes) before
// going into the script. The old double-quoting (`cd "${pathApps}"`)
// still let `$(...)`/backticks run inside it and broke outright on an
// embedded `"` — single quotes suppress both.

import { normalizeRemotePath } from "../server-keys.ts"
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
  /**
   * Set when the deploy recreated the stack's containers because one of them
   * was created from another folder: that container and its old folder, as
   * the server reported them.
   */
  recreated?: string
  /**
   * What the stale-container cleanup did before `up`, one line each: a
   * container it removed, or one it kept although it looks like this stack's.
   */
  stale?: string[]
}

/**
 * Seconds between the last stack's `up -d` and the look at every stack's
 * containers. One wait per deploy, not per stack, and none when no stack
 * has a container.
 */
export const VERIFY_WAIT_SECONDS = 5

/** How many of a failed container's last log lines the deploy prints. */
export const VERIFY_LOG_LINES = 20

/**
 * The bytes of each of those log lines the deploy keeps, so one container
 * that logs a huge line (a JSON blob, a binary dump) adds at most
 * VERIFY_LOG_LINES times this to the summary.
 */
export const VERIFY_LOG_LINE_BYTES = 300

/** Shell function that prints one line per container of a compose project. */
const CONTAINERS_FN = "rostok_containers"

/** Shell variable that is set once a started stack has a container to look at. */
const VERIFY_WAIT_VAR = "rostok_verify_wait"

/** Shell variable that is set once a stack needs the second look. */
const RECHECK_VAR = "rostok_recheck"

/** What the look reports for a container restarted exactly once during the wait. */
const RESTARTED_ONCE = "restarted"

/**
 * Defines three shell functions.
 *
 * `rostok_containers <project>` prints one line per container of the
 * compose project, `id|name|status|exit code|restart count|finished at`.
 * A `while read` loop rather than one `docker inspect` over all IDs: the
 * remote login shell can be zsh, which does not split an unquoted
 * expansion into words.
 *
 * `rostok_look <project> <started> <before>` prints `id|name|reason` for
 * each container that failed since `<started>` (the time this stack's
 * `up` began), comparing restart counts with the `rostok_containers`
 * lines in `<before>`. A container restarted exactly once gets the reason
 * RESTARTED_ONCE: not a failure yet, but worth a second look. A restart
 * count that is not a plain number is never used in arithmetic: the shell
 * would evaluate it as an expression.
 *
 * `rostok_finish <verify marker> <failed marker> <success marker>
 * <findings>` prints the verify marker, then either each finding with its
 * container's last log lines, each cut to VERIFY_LOG_LINE_BYTES, and the
 * failed marker, or the success marker when there is none.
 */
const VERIFY_PREAMBLE = `
${CONTAINERS_FN}() {
  docker ps -a -q --filter "label=com.docker.compose.project=\$1" 2>/dev/null | while read -r rostok_id; do
    [ -n "\$rostok_id" ] || continue
    docker inspect --format '{{.Id}}|{{.Name}}|{{.State.Status}}|{{.State.ExitCode}}|{{.RestartCount}}|{{.State.FinishedAt}}' "\$rostok_id" 2>/dev/null
  done
}
rostok_look() {
  rostok_look_started=\$2
  rostok_look_before=\$3
  ${CONTAINERS_FN} "\$1" | while IFS='|' read -r rostok_id rostok_name rostok_status rostok_code rostok_restarts rostok_finished; do
    rostok_reason=
    case "\$rostok_status" in
      restarting) rostok_reason='is restarting' ;;
      exited|dead)
        if [ "\$rostok_code" != 0 ] && LC_ALL=C expr "x\$rostok_finished" '>=' "x\$rostok_look_started" >/dev/null; then
          rostok_reason="exited with code \$rostok_code"
        fi ;;
    esac
    if [ -z "\$rostok_reason" ]; then
      rostok_was=\$(printf '%s\\n' "\$rostok_look_before" | awk -F'|' -v id="\$rostok_id" '\$1 == id { print \$5 }')
      case "\$rostok_was" in ''|*[!0-9]*|0?*) rostok_was= ;; esac
      case "\$rostok_restarts" in ''|*[!0-9]*|0?*) rostok_was= ;; esac
      if [ -z "\$rostok_was" ]; then
        :
      elif [ "\$rostok_restarts" -ge "\$((rostok_was + 2))" ]; then
        rostok_reason='keeps restarting'
      elif [ "\$rostok_restarts" -gt "\$rostok_was" ]; then
        rostok_reason=${RESTARTED_ONCE}
      fi
    fi
    [ -n "\$rostok_reason" ] || continue
    printf '%s|%s|%s\\n' "\$rostok_id" "\$rostok_name" "\$rostok_reason"
  done
}
rostok_finish() {
  printf '%s\\n' "\$1"
  if [ -z "\$4" ]; then
    printf '%s\\n' "\$3"
    return 0
  fi
  printf '%s\\n' "\$4" | while IFS='|' read -r rostok_id rostok_name rostok_reason; do
    [ -n "\$rostok_id" ] || continue
    printf 'Container %s %s. Its last log lines:\\n' "\${rostok_name#/}" "\$rostok_reason"
    docker logs --tail ${VERIFY_LOG_LINES} "\$rostok_id" 2>&1 | cut -c 1-${VERIFY_LOG_LINE_BYTES} | sed 's/^/  /'
  done
  printf '%s\\n' "\$2"
}
${VERIFY_WAIT_VAR}=
${RECHECK_VAR}=
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

/** Shell variable that is non-empty when this stack's `up` must recreate its containers. */
const RECREATE_VAR = "rostok_recreate"

/**
 * Generate a shell script that deploys all stacks in one SSH session and
 * prints structured `DEPLOY_START`/`DEPLOY_SUCCESS`/`DEPLOY_FAILED`
 * markers `parseDeployResults` reads back.
 *
 * It runs in two parts. The first starts every stack with `up -d`; a stack
 * whose `up` fails is marked failed there. A stack gets `up -d
 * --force-recreate` instead when one of its containers was created from
 * another folder than `<pathApps>/stacks/<stack>` (#384): compose leaves a
 * container with an unchanged configuration as it is, so it would keep the
 * old folder in its `com.docker.compose.project.working_dir` label, and the
 * backup runner stops and starts a stack from the folder that label names.
 * A `DEPLOY_RECREATE` line names the first such container and its old
 * folder. The second waits
 * VERIFY_WAIT_SECONDS once and looks at the containers of every stack that
 * started (#383): `up -d` returns 0 as soon as the containers are created,
 * so a container that dies at start used to count as a success. A stack is
 * marked failed when one of its containers
 *
 * - is restarting at the look, or was restarted by Docker two or more
 *   times since `up`: a crash loop. One restart is not a failure: a
 *   service that exits once because its database is not up yet, and then
 *   stays up, is healthy. A stack with a container restarted exactly once,
 *   and nothing else wrong, gets a second look after another
 *   VERIFY_WAIT_SECONDS, so a loop slower than the first wait is caught
 *   when it restarts again by then;
 * - has exited with a non-zero code since this stack's `up` began. An
 *   older exit is left alone: it is not this deploy's doing, and `up`
 *   leaves a container of a service that compose no longer lists as it is.
 *
 * The failed container's last VERIFY_LOG_LINES log lines follow, indented
 * and each cut to VERIFY_LOG_LINE_BYTES, after a `DEPLOY_VERIFY` marker. A
 * one-shot container that exited 0, and one whose health check is still
 * starting or failing, do not fail the stack. A container that dies later
 * than the last look is not seen. Each line of the stale-container cleanup
 * starts with a `DEPLOY_STALE` marker, so the summary can show it.
 */
export function generateDeployScript(
  stacks: StackConfig[],
  pathApps: string,
  restartStacks: Set<string>,
): string {
  const stackCommands: string[] = [VERIFY_PREAMBLE]
  const verifyCommands: string[] = []
  const recheckCommands: string[] = []

  for (const [index, stackConfig] of stacks.entries()) {
    const upVar = `rostok_up_${index}`
    const startedVar = `rostok_started_${index}`
    const beforeVar = `rostok_before_${index}`
    const suspectVar = `rostok_suspect_${index}`
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
    const recreateMarker = shQuote(`DEPLOY_RECREATE:${stackName}:${deployAs}`)
    const staleMarker = shQuote(`DEPLOY_STALE:${stackName}:${deployAs}`)
    // The instances of this stack in this deploy, as a case pattern. It
    // holds this one's own deployAs too, which the loop skips before, so it
    // is never empty.
    const siblingPattern = stacks
      .filter((s) => s.name === stackName)
      .map((s) => shQuote(s.deployAs || s.name))
      .join("|")
    // What compose writes into the working_dir label of a container it
    // creates here: the folder of the first -f file.
    const stackDir = shQuote(`${normalizeRemotePath(pathApps)}/stacks/${stackName}`)
    const compose =
      `cd ${quotedPathApps} && docker compose ${projectFlag} --env-file=.env.root --env-file=.env "\$@"`

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
#
# A container of another compose project that was created from this stack's
# compose file but has none of its container_names (a service without one)
# is only reported: it may be another instance of this stack under its own
# deployAs, which a single-stack deploy does not list. The instances this
# deploy does list are skipped.
docker ps -a --format '{{.Names}}|{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.config_files"}}' 2>/dev/null | while IFS='|' read -r cname id proj files; do
  [ "\$proj" != ${shQuote(deployAs)} ] && [ -n "\$id" ] || continue
  case ",\$files," in
    *${shQuote(`/stacks/${stackName}/compose.yml,`)}*) own=1 ;;
    *) own= ;;
  esac
  if printf '%s\\n' "\$${STALE_NAMES_VAR}" | grep -qxF -- "\$cname"; then
    if [ -n "\$proj" ] && [ -n "\$own" ]; then
      printf '%s removing stale container %s (project=%s, expected=%s)\\n' ${staleMarker} "\$cname" "\$proj" ${
      shQuote(deployAs)
    }
      docker rm -f "\$id" >/dev/null 2>&1 || true
    else
      printf '%s keeping container %s: it has this stack'"'"'s name but was not created from stacks/%s/compose.yml (project=%s)\\n' ${staleMarker} "\$cname" ${
      shQuote(stackName)
    } "\$proj"
    fi
  elif [ -n "\$proj" ] && [ -n "\$own" ]; then
    case "\$proj" in
      ${siblingPattern}) continue ;;
    esac
    printf '%s keeping container %s of project %s: it was created from stacks/%s/compose.yml too; remove it with docker rm -f if it is an old copy of this stack\\n' ${staleMarker} "\$cname" "\$proj" ${
      shQuote(stackName)
    }
  fi
done
# A container of this project that was created from another folder (an older
# checkout, a hand-run docker compose) and whose configuration is unchanged
# is left as it is by \`up\`, old folder in its labels and all. So \`up\`
# recreates the stack's containers when it finds one. Only a container that
# \`up\` manages counts: its service is in this stack's compose files and it
# is not a \`compose run\` one-off. An orphan of a removed service would
# otherwise force a recreate on every deploy, because nothing ever gives it
# the new folder. The services are asked for only when a folder differs.
${RECREATE_VAR}=
rostok_moved=\$(docker ps -a --filter ${
      shQuote(`label=com.docker.compose.project=${deployAs}`)
    } --format '{{.Names}}|{{.Label "com.docker.compose.service"}}|{{.Label "com.docker.compose.oneoff"}}|{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | while IFS='|' read -r rostok_name rostok_service rostok_oneoff rostok_dir; do
  [ -n "\$rostok_service" ] && [ "\$rostok_oneoff" != True ] && [ "\$rostok_dir" != ${stackDir} ] || continue
  printf '%s|%s|%s\\n' "\$rostok_name" "\$rostok_service" "\$rostok_dir"
done)
if [ -n "\$rostok_moved" ]; then
  rostok_services=\$(${compose} config --services 2>/dev/null)
  ${RECREATE_VAR}=\$(printf '%s\\n' "\$rostok_moved" | while IFS='|' read -r rostok_name rostok_service rostok_dir; do
    printf '%s\\n' "\$rostok_services" | grep -qxF -- "\$rostok_service" || continue
    printf '%s container %s was created from %s, not from %s\\n' ${recreateMarker} "\$rostok_name" "\$rostok_dir" ${stackDir}
    break
  done)
  if [ -n "\$${RECREATE_VAR}" ]; then printf '%s\\n' "\$${RECREATE_VAR}"; fi
fi
${startedVar}=\$(date -u +%Y-%m-%dT%H:%M:%S)
${compose} up -d --build \${${RECREATE_VAR}:+--force-recreate} 2>&1
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
    // `status` and others for itself. A stack with a container restarted
    // once, and nothing else wrong, gets its result after the second look.
    const finishArgs = `${verifyMarker} ${failedMarker} ${successMarker}`
    verifyCommands.push(`
if [ -n "\$${upVar}" ]; then
  rostok_found=\$(rostok_look ${shQuote(deployAs)} "\$${startedVar}" "\$${beforeVar}")
  ${suspectVar}=\$(printf '%s\\n' "\$rostok_found" | awk -F'|' '\$3 == "${RESTARTED_ONCE}" { printf "%s ", \$1 }')
  rostok_failed=\$(printf '%s\\n' "\$rostok_found" | awk -F'|' 'NF && \$3 != "${RESTARTED_ONCE}"')
  if [ -n "\$rostok_failed" ] || [ -z "\$${suspectVar}" ]; then
    ${suspectVar}=
    rostok_finish ${finishArgs} "\$rostok_failed"
  else
    ${RECHECK_VAR}=1
  fi
fi
`)
    // The second look counts only the containers that restarted once: one
    // that restarted again since is a crash loop slower than the first wait.
    recheckCommands.push(`
if [ -n "\$${suspectVar}" ]; then
  rostok_found=\$(rostok_look ${
      shQuote(deployAs)
    } "\$${startedVar}" "\$${beforeVar}" | awk -F'|' -v ids="\$${suspectVar}" 'BEGIN { n = split(ids, a, " "); for (i = 1; i <= n; i++) s[a[i]] = 1 } s[\$1] && \$3 != "${RESTARTED_ONCE}"')
  rostok_finish ${finishArgs} "\$rostok_found"
fi
`)
  }

  return [
    ...stackCommands,
    `if [ -n "\$${VERIFY_WAIT_VAR}" ]; then sleep ${VERIFY_WAIT_SECONDS}; fi`,
    ...verifyCommands,
    `if [ -n "\$${RECHECK_VAR}" ]; then sleep ${VERIFY_WAIT_SECONDS}; fi`,
    ...recheckCommands,
  ].join("\n")
}

/**
 * True when `line` starts with `marker` and the name that ends the marker
 * ends there too: a stack deployed as `blog` must never take the line of
 * the one deployed as `blog2`. A marker counts only at the start of a
 * line: the log lines of a failed container are printed into the same
 * output, indented, and must not be read as one.
 */
function isMarkerLine(line: string, marker: string): boolean {
  return line.startsWith(marker) && !/[A-Za-z0-9_.-]/.test(line.charAt(marker.length))
}

/** Parse the deploy output to extract results for each stack. */
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
    // The space ends the marker: no stack or project name contains one.
    const recreateMarker = `DEPLOY_RECREATE:${stackName}:${deployAs} `
    const staleMarker = `DEPLOY_STALE:${stackName}:${deployAs} `
    const recreated = lines.find((line) => line.startsWith(recreateMarker))
      ?.slice(recreateMarker.length)
    const stale = lines.filter((line) => line.startsWith(staleMarker))
      .map((line) => line.slice(staleMarker.length))

    const isSuccess = lines.some((line) => isMarkerLine(line, successMarker))
    const endIdx = lines.findIndex((line) => isMarkerLine(line, failedMarker))
    const isFailed = endIdx !== -1

    // The error is what the stack printed last before it failed: the
    // report on its containers when `up` had succeeded, else `up`'s output.
    // The recreate and stale-container lines are left out of it: the
    // summary prints them on their own.
    let errorOutput = ""
    let containerFailed = false
    if (isFailed) {
      const before = lines.slice(0, endIdx)
      const verifyIdx = before.findLastIndex((line) => isMarkerLine(line, verifyMarker))
      containerFailed = verifyIdx !== -1
      const startIdx = containerFailed
        ? verifyIdx
        : before.findLastIndex((line) => isMarkerLine(line, startMarker))
      if (startIdx !== -1) {
        errorOutput = before.slice(startIdx + 1)
          .filter((line) => !line.startsWith(recreateMarker) && !line.startsWith(staleMarker))
          .join("\n")
      }
    }

    results.push({
      name: stackName,
      deployAs,
      success: isSuccess && !isFailed,
      error: isFailed ? errorOutput : undefined,
      ...(containerFailed ? { containerFailed } : {}),
      ...(recreated ? { recreated } : {}),
      ...(stale.length > 0 ? { stale } : {}),
    })
  }

  return results
}

/**
 * Says which stale containers the deploy removed or kept, and why a
 * stack's running containers restarted. The text holds container names
 * and folders as the server reported them, so control characters are
 * stripped.
 */
function printStackNotes(result: DeployResult): void {
  for (const line of result.stale ?? []) console.log(`     ${stripControlChars(line)}`)
  if (!result.recreated) return
  console.log(`     Recreated its containers: ${stripControlChars(result.recreated)}`)
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
      printStackNotes(result)
    }
  }

  if (failed.length > 0) {
    console.log(`\n❌ Failed (${failed.length}/${results.length}):`)
    for (const result of failed) {
      const displayName = result.deployAs !== result.name
        ? `${result.name} (as ${result.deployAs})`
        : result.name
      console.log(`   ✗ ${displayName}`)
      printStackNotes(result)
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
