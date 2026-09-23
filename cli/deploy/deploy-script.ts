// Builds and parses the remote `docker compose` script deploy runs over
// a single SSH session. Ported from the old scripts/deploy/src/+lib.ts —
// every value that comes from `.env`/`config.json` (PATH_APPS, a stack
// name, deployAs) is now quoted with `shQuote` (single quotes) before
// going into the script. The old double-quoting (`cd "${pathApps}"`)
// still let `$(...)`/backticks run inside it and broke outright on an
// embedded `"` — single quotes suppress both.

import { runRemoteShell, shQuote } from "./exec.ts"

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
}

/**
 * Generate a bash script that deploys all stacks in one SSH session and
 * prints structured `DEPLOY_START`/`DEPLOY_SUCCESS`/`DEPLOY_FAILED`
 * markers `parseDeployResults` reads back.
 */
export function generateDeployScript(
  stacks: StackConfig[],
  pathApps: string,
  restartStacks: Set<string>,
): string {
  const stackCommands: string[] = []

  for (const stackConfig of stacks) {
    const stackName = stackConfig.name
    const deployAs = stackConfig.deployAs || stackName
    const projectFlag = `-p ${shQuote(deployAs)}`
    const needsRestart = restartStacks.has(deployAs)
    const quotedPathApps = shQuote(pathApps)
    const startMarker = shQuote(`DEPLOY_START:${stackName}:${deployAs}`)
    const successMarker = shQuote(`DEPLOY_SUCCESS:${stackName}:${deployAs}`)
    const failedMarker = shQuote(`DEPLOY_FAILED:${stackName}:${deployAs}`)
    const restartingMarker = shQuote(`RESTARTING:${stackName}:${deployAs}`)
    const restartDoneMarker = shQuote(`RESTART_DONE:${stackName}:${deployAs}`)

    stackCommands.push(`
echo ${startMarker}
# Belt-and-braces: drop any existing container with the stack's container_name
# that doesn't belong to the current compose project. Happens when a stack
# was previously deployed with a different project name (e.g. manual
# \`docker compose up\` that picked up \`name: \${PROJECT}\` from compose.yml,
# producing project=hl, vs the deploy script's -p ${deployAs} producing
# project=${deployAs}). Same container_name under two different projects
# → "name already in use" conflict on every redeploy.
# Data lives in volumes, not in the container, so this is safe.
cd ${quotedPathApps} && docker ps -a --filter ${
      shQuote(`name=hl-${stackName}`)
    } --format '{{.ID}} {{.Label "com.docker.compose.project"}}' 2>/dev/null | while read id proj; do
  if [ "\$proj" != ${shQuote(deployAs)} ] && [ -n "\$id" ]; then
    echo "  removing stale container $id (project=$proj, expected="${shQuote(deployAs)}")"
    docker rm -f "\$id" >/dev/null 2>&1 || true
  fi
done
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
cd ${quotedPathApps} && docker compose ${projectFlag} --env-file=.env.root --env-file=.env "\$@" up -d --build 2>&1
if [ $? -eq 0 ]; then
  echo ${successMarker}
else
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
`)
  }

  return stackCommands.join("\n")
}

/** Parse the deploy output to extract results for each stack. */
export function parseDeployResults(output: string, stacks: StackConfig[]): DeployResult[] {
  const results: DeployResult[] = []
  const lines = output.split("\n")

  for (const stackConfig of stacks) {
    const stackName = stackConfig.name
    const deployAs = stackConfig.deployAs || stackName

    const successMarker = `DEPLOY_SUCCESS:${stackName}:${deployAs}`
    const failedMarker = `DEPLOY_FAILED:${stackName}:${deployAs}`

    const isSuccess = lines.some((line) => line.includes(successMarker))
    const isFailed = lines.some((line) => line.includes(failedMarker))

    let errorOutput = ""
    if (isFailed) {
      const startIdx = lines.findIndex((l) => l.includes(`DEPLOY_START:${stackName}:${deployAs}`))
      const endIdx = lines.findIndex((l) => l.includes(failedMarker))
      if (startIdx !== -1 && endIdx !== -1) {
        errorOutput = lines.slice(startIdx + 1, endIdx).join("\n")
      }
    }

    results.push({
      name: stackName,
      deployAs,
      success: isSuccess && !isFailed,
      error: isFailed ? errorOutput : undefined,
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
      if (result.error) {
        console.log(
          `     Error: ${result.error.substring(0, 200)}${result.error.length > 200 ? "..." : ""}`,
        )
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
