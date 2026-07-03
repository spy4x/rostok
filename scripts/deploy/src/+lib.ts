// Deploy utility functions — extracted for testability

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
 * Extract volume paths from compose files that need to be created
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
      volumePaths.add(`${env["VOLUMES_PATH"] || "${VOLUMES_PATH}"}/${expandedPath}`)
    }
  }

  return Array.from(volumePaths)
}

/**
 * Generate a shell script to create volume directories with correct ownership
 */
export function generateVolumeCreationScript(volumePaths: string[], user: string): string {
  const commands = volumePaths.map((path) => {
    return `mkdir -p "${path}" 2>/dev/null; chown -R ${user}:${user} "${path}" 2>/dev/null || true`
  })

  return commands.join(" && ")
}

/**
 * Generate a bash script that deploys all stacks and outputs structured results
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
    const projectFlag = `-p ${deployAs}`
    const needsRestart = restartStacks.has(deployAs)

    stackCommands.push(`
echo "DEPLOY_START:${stackName}:${deployAs}"
cd ${pathApps} && docker compose ${projectFlag} --env-file=.env.root --env-file=.env -f stacks/${stackName}/compose.yml up -d --build 2>&1
if [ $? -eq 0 ]; then
  echo "DEPLOY_SUCCESS:${stackName}:${deployAs}"
else
  echo "DEPLOY_FAILED:${stackName}:${deployAs}"
fi
${
      needsRestart
        ? `
echo "RESTARTING:${stackName}:${deployAs}"
cd ${pathApps} && docker compose ${projectFlag} -f stacks/${stackName}/compose.yml restart 2>&1
echo "RESTART_DONE:${stackName}:${deployAs}"
`
        : ""
    }
`)
  }

  return stackCommands.join("\n")
}

/**
 * Parse the deploy output to extract results for each stack
 */
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

/**
 * Print a summary of deployment results
 */
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
 * Compute SHA256 checksums of config files on remote server
 * Returns map of file path (relative to PATH_APPS) to checksum
 */
export async function getRemoteChecksums(
  sshAddress: string,
  pathApps: string,
  watchFilesAndRestartIfChanged: string[],
): Promise<Map<string, string>> {
  const checksums = new Map<string, string>()

  for (const filePath of watchFilesAndRestartIfChanged) {
    const remotePath = `${pathApps}/${filePath}`
    const result = await runCommand([
      "ssh",
      sshAddress,
      `sha256sum "${remotePath}" 2>/dev/null || true`,
    ])

    if (result.success && result.output) {
      const hash = result.output.split(/\s+/)[0]
      if (hash && hash.length === 64) {
        checksums.set(filePath, hash)
      }
    }
  }

  return checksums
}

// Minimal runCommand for remote checksums (avoids circular dep with +lib.ts)
async function runCommand(
  cmd: string[],
): Promise<{ success: boolean; output: string; error: string }> {
  const proc = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  })
  const output = await proc.output()
  return {
    success: output.code === 0,
    output: new TextDecoder().decode(output.stdout),
    error: new TextDecoder().decode(output.stderr),
  }
}
