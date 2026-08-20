// Deploy script that copies server files and stacks, then spins up docker compose
// Usage: deno run -A scripts/deploy/+main.ts <target> [stack]
// Example: deno run -A scripts/deploy/+main.ts offsite
// Example: deno run -A scripts/deploy/+main.ts home plausible

import { error, log, runCommand, success } from "../+lib.ts"
import { load } from "@std/dotenv"
import {
  extractVolumePaths,
  generateDeployScript,
  generateVolumeCreationScript,
  getRemoteChecksums,
  parseDeployResults,
  printDeploySummary,
  type StackConfig,
} from "./src/+lib.ts"

// Parse command line arguments
const args = Deno.args
if (args.length < 1) {
  error("Usage: deno run -A scripts/deploy/+main.ts <target> [stack]")
  error("Example: deno run -A scripts/deploy/+main.ts offsite")
  error("Example: deno run -A scripts/deploy/+main.ts home plausible")
  Deno.exit(1)
}

const target = args[0]
const stackFilter = args[1] // optional: deploy only this stack

const targetPath = `./servers/${target}`

// Load target's .env file to get SSH_ADDRESS and PATH_APPS
const targetEnvPath = `${targetPath}/.env`
const targetEnv = await load({ envPath: targetEnvPath })

const SSH_ADDRESS = targetEnv["SSH_ADDRESS"]
const PATH_APPS = targetEnv["PATH_APPS"]
const VOLUMES_PATH = targetEnv["VOLUMES_PATH"]
const HOMELAB_USER = targetEnv["HOMELAB_USER"] || "homelab"

if (!SSH_ADDRESS || !PATH_APPS) {
  error(`SSH_ADDRESS and PATH_APPS must be set in ${targetEnvPath}`)
  Deno.exit(1)
}

// Load target's config.json to get required stacks
const configPath = `${targetPath}/config.json`
let config: { stacks?: StackConfig[] } = {}
try {
  const configContent = await Deno.readTextFile(configPath)
  config = JSON.parse(configContent)
} catch (err) {
  if (err instanceof Deno.errors.NotFound) {
    log(`${configPath} not found, proceeding without stacks`)
  } else {
    throw err
  }
}

let stacks = config.stacks || []

// If a specific stack is requested, filter to only that stack
if (stackFilter) {
  const filtered = stacks.filter((s) => s.name === stackFilter)
  if (filtered.length === 0) {
    error(`Stack '${stackFilter}' not found in server '${target}' config.json`)
    error(`Available stacks: ${stacks.map((s) => s.name).join(", ")}`)
    Deno.exit(1)
  }
  log(`Deploying single stack: ${stackFilter}`)
  stacks = filtered
}

// Create temporary directory for deployment files
const tempDir = await Deno.makeTempDir({ prefix: "deploy_" })
log(`Created temp dir: ${tempDir}`)

try {
  // Copy server folder contents to temp directory. `compose-override/` lets
  // each server commit per-stack bind mounts (e.g.
  // servers/home/compose-override/syncthing.yml) without polluting the
  // generic stacks/<stack>/compose.yml.
  const whitelist = [".env", "configs/", "compose-override/"]
  log("Copying files to temp dir...")
  for (const item of whitelist) {
    const srcPath = `${targetPath}/${item}`
    const destPath = `${tempDir}/${item}`

    try {
      const stat = await Deno.stat(srcPath)
      log(` + ${item}`)
      if (stat.isDirectory) {
        await copyDirectory(srcPath, destPath)
      } else if (stat.isFile) {
        await Deno.copyFile(srcPath, destPath)
      }
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        log(` - ${item} not found, skipping...`)
        continue
      }
      throw err
    }
  }

  await Deno.copyFile("./.env.root", `${tempDir}/.env.root`)
  log(` + /.env.root`)

  await copyDirectory("./scripts", `${tempDir}/scripts`)
  log(` + /scripts/`)

  await Deno.copyFile("./deno.jsonc", `${tempDir}/deno.jsonc`)
  log(` + /deno.jsonc`)

  // Copy required stacks to temp directory
  if (stacks.length > 0) {
    await Deno.mkdir(`${tempDir}/stacks`, { recursive: true })
    for (const stackConfig of stacks) {
      const stackName = stackConfig.name
      const stackPath = `./stacks/${stackName}`
      const destPath = `${tempDir}/stacks/${stackName}`

      try {
        await copyDirectory(stackPath, destPath)
        log(` + /stacks/${stackName}`)
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) {
          error(`Stack not found: ${stackPath}`)
          Deno.exit(1)
        }
        throw err
      }
    }
  }

  // Handle "before.deploy.ts" scripts for stacks
  for (const stackConfig of stacks) {
    const stackName = stackConfig.name
    const deployAs = stackConfig.deployAs || stackName
    const envs = stackConfig.envs || {}

    // fill placeholders in envs
    for (const [key, value] of Object.entries(envs)) {
      if (typeof value !== "string") {
        error(`Invalid env value for key '${key}' in stack '${stackName}', must be a string`)
        continue
      }
      const filledValue = value.replace(/\${([^}]+)}/g, (_match, envVarName) => {
        const envValue = targetEnv[envVarName.trim()]
        if (envValue === undefined) {
          error(
            `Environment variable '${envVarName.trim()}' not found for stack '${stackName}'`,
          )
          return _match
        }
        return envValue
      })

      // add env to .env file in tempDir, but only if not already present
      const envFilePath = `${tempDir}/.env`
      let envFileContent = await Deno.readTextFile(envFilePath)
      if (!envFileContent.includes(`${key}=`)) {
        envFileContent += `\n${key}=${filledValue}\n`
        await Deno.writeTextFile(envFilePath, envFileContent)
        log(`Added env ${key} for stack ${stackName} to .env file`)
      }
    }

    // Check for stack-level before.deploy.ts
    const stackBeforeDeployPath = `${tempDir}/stacks/${stackName}/before.deploy.ts`
    const hasStackBeforeDeploy = await Deno.stat(stackBeforeDeployPath).then(() => true).catch(() =>
      false
    )
    if (hasStackBeforeDeploy) {
      log(`Running before.deploy.ts for stack ${stackName}...`)
      const proc = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          // Stack-level before.deploy hooks commonly need: htpasswd
          // (traefik), ssh/docker/bash (syncthing), and friends.
          "--allow-run=htpasswd,ssh,docker,bash,mkdir,chown,test,rm,printf,wget,cp,mv,ln",
          "--allow-net=localhost",
          "-R",
          "-W",
          "-E",
          ...(stackName === "stalwart" && targetEnv["DOMAIN"]
            ? [`--allow-net=mail.${targetEnv["DOMAIN"]}`]
            : []),
          "--env-file=.env.root",
          "--env-file=.env",
          stackBeforeDeployPath,
        ],
        cwd: tempDir,
        env: { DEPLOY_AS: deployAs },
      })
      const output = await proc.output()
      if (output.code !== 0) {
        error(`before.deploy.ts failed for stack: ${stackName}`)
        error(new TextDecoder().decode(output.stderr))
        Deno.exit(1)
      }
      success(`✓ before.deploy.ts for ${stackName}`)
    }

    // Check for server-specific before.deploy.ts
    const serverBeforeDeployPath = `${tempDir}/configs/${deployAs}/before.deploy.ts`
    const hasServerBeforeDeploy = await Deno.stat(serverBeforeDeployPath).then(() => true).catch(
      () => false,
    )
    if (hasServerBeforeDeploy) {
      log(`Running server-specific before.deploy.ts for ${deployAs}...`)
      const proc = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--allow-run=htpasswd,ssh,docker,bash,mkdir,chown,test,rm,printf,wget,cp,mv,ln",
          "--allow-net=localhost",
          "-R",
          "-W",
          "-E",
          "--env-file=.env.root",
          "--env-file=.env",
          serverBeforeDeployPath,
        ],
        cwd: tempDir,
      })
      const output = await proc.output()
      if (output.code !== 0) {
        error(`server-specific before.deploy.ts failed for: ${deployAs}`)
        error(new TextDecoder().decode(output.stderr))
        Deno.exit(1)
      }
      success(`✓ server-specific before.deploy.ts for ${deployAs}`)
    }
  }

  // Snapshot checksums of watched config files before rsync
  const stacksWithConfigFiles = stacks.filter((s) =>
    s.watchFilesAndRestartIfChanged && s.watchFilesAndRestartIfChanged.length > 0
  )
  const checksumsBefore = new Map<string, Map<string, string>>()
  if (stacksWithConfigFiles.length > 0) {
    for (const stack of stacksWithConfigFiles) {
      const deployAs = stack.deployAs || stack.name
      const checksums = await getRemoteChecksums(
        SSH_ADDRESS,
        PATH_APPS,
        stack.watchFilesAndRestartIfChanged!,
      )
      checksumsBefore.set(deployAs, checksums)
    }
  }

  // Rsync temp directory to remote server
  log(`Syncing files to ${SSH_ADDRESS}:${PATH_APPS}...`)
  const rsyncArgs = [
    "-avhzru",
    // Don't use --delete to avoid permission issues with running containers
    // "--delete",
    "-e",
    "ssh",
    `${tempDir}/`,
    `${SSH_ADDRESS}:${PATH_APPS}/`,
  ]

  const rsyncCommand = await runCommand(["rsync", ...rsyncArgs])
  if (!rsyncCommand.success) {
    error("Rsync failed")
    error(rsyncCommand.error)
    Deno.exit(1)
  }
  success("Synced completed successfully")

  // Clean up stale stack directories on remote server (removed from config.json)
  // Use the full config.stacks list, not the filtered one (single-stack deploy)
  log("Cleaning up stale stack directories...")
  const activeStacks = (config.stacks || []).map((s) => s.name)
  const stackNamesPattern = activeStacks.map((s) => `" ${s} "`).join("|")
  const remoteStacksScript = [
    `cd ${PATH_APPS}/stacks || exit 0`,
    `for dir in */; do`,
    `  dir_name="\${dir%/}"`,
    `  case " \${dir_name} " in`,
    `    ${stackNamesPattern}) ;;`,
    `    *) echo "Removing stale stack: \${dir_name}"; rm -rf "\${dir}";;`,
    `  esac`,
    `done`,
  ].join("\n")
  const cleanupCommand = await runCommand(["ssh", SSH_ADDRESS, remoteStacksScript])
  if (!cleanupCommand.success) {
    log(`Warning: Failed to clean up stale stacks: ${cleanupCommand.error}`)
  } else {
    success("Stale stacks cleaned up")
  }

  // Snapshot checksums after rsync and detect changes
  const restartStacks = new Set<string>()
  if (stacksWithConfigFiles.length > 0) {
    for (const stack of stacksWithConfigFiles) {
      const deployAs = stack.deployAs || stack.name
      const checksumsAfter = await getRemoteChecksums(
        SSH_ADDRESS,
        PATH_APPS,
        stack.watchFilesAndRestartIfChanged!,
      )
      const before = checksumsBefore.get(deployAs)

      if (before) {
        for (const [filePath, hashAfter] of checksumsAfter) {
          const hashBefore = before.get(filePath)
          if (hashBefore !== hashAfter) {
            log(`Config changed for ${deployAs}: ${filePath}`)
            restartStacks.add(deployAs)
          }
        }
      }
    }
  }

  // Run docker compose on remote server
  // First, ensure proxy network exists
  log("Ensuring proxy network exists on remote server...")
  const createNetworkCmd =
    `docker network inspect proxy >/dev/null 2>&1 || docker network create proxy`

  const networkCommand = await runCommand(["ssh", SSH_ADDRESS, createNetworkCmd])
  if (!networkCommand.success) {
    error("Failed to create proxy network on remote server")
    error(networkCommand.error)
    Deno.exit(1)
  }
  success("Proxy network ensured")

  // Deploy stacks in a single SSH session
  if (stacks.length > 0) {
    log("Deploying stacks...")

    // Extract volume paths from compose files and create them on the remote server
    const volumePaths = await extractVolumePathsForStacks(stacks, tempDir, targetEnv)
    if (volumePaths.length > 0 && VOLUMES_PATH) {
      log(`Creating ${volumePaths.length} volume directories with correct ownership...`)
      const createVolumesScript = generateVolumeCreationScript(volumePaths, HOMELAB_USER)
      const volumesCommand = await runCommand(["ssh", SSH_ADDRESS, createVolumesScript])
      if (!volumesCommand.success) {
        log(`Warning: Some volume directories may not have been created: ${volumesCommand.error}`)
      } else {
        success("Volume directories created")
      }
    }

    // Build a single script that deploys all stacks and tracks results
    const deployScript = generateDeployScript(stacks, PATH_APPS, restartStacks)

    // Execute the deploy script in a single SSH session
    const deployCommand = await runCommand(["ssh", SSH_ADDRESS, deployScript])

    // Parse the results from the output
    const results = parseDeployResults(deployCommand.output, stacks)

    // Print summary
    printDeploySummary(results)

    // Check if any failed
    const failedCount = results.filter((r) => !r.success).length
    if (failedCount > 0) {
      error(`${failedCount} stack(s) failed to deploy`)
      throw new Error("Skipping post-deploy hooks after stack deployment failure")
    }
  } else {
    log("No stacks to deploy")
  }

  // Handle "after.deploy.ts" scripts for stacks (runs AFTER docker compose deployment).
  // Track per-stack failure to surface in the final exit code (CI-friendly).
  const afterDeployFailures: string[] = []
  for (const stackConfig of stacks) {
    const stackName = stackConfig.name
    const deployAs = stackConfig.deployAs || stackName

    const stackAfterDeployPath = `${tempDir}/stacks/${stackName}/after.deploy.ts`
    const hasStackAfterDeploy = await Deno.stat(stackAfterDeployPath).then(() => true).catch(() =>
      false
    )
    if (hasStackAfterDeploy) {
      log(`Running after.deploy.ts for stack ${stackName}...`)
      const proc = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--env-file=.env.root",
          "--env-file=.env",
          stackAfterDeployPath,
        ],
        cwd: tempDir,
        env: { DEPLOY_AS: deployAs, SSH_ADDRESS, PATH_APPS },
      })
      const output = await proc.output()
      if (output.code !== 0) {
        error(`after.deploy.ts failed for stack: ${stackName}`)
        error(new TextDecoder().decode(output.stderr))
        afterDeployFailures.push(stackName)
      } else {
        success(`✓ after.deploy.ts for ${stackName}`)
      }
    }
  }

  if (afterDeployFailures.length > 0) {
    error(`after.deploy.ts failed for stacks: ${afterDeployFailures.join(", ")}`)
    Deno.exit(1)
  }

  log("Deployment script finished")
} finally {
  // Clean up temp directory
  try {
    await Deno.remove(tempDir, { recursive: true })
    log(`Cleaned up temporary directory`)
  } catch (err) {
    log(`Warning: Failed to clean up temp directory: ${err}`)
  }
}

/**
 * Extract volume paths from compose files that need to be created
 */
async function extractVolumePathsForStacks(
  stacks: StackConfig[],
  tempDir: string,
  env: Record<string, string>,
): Promise<string[]> {
  const composeContents: string[] = []
  for (const stackConfig of stacks) {
    const composePath = `${tempDir}/stacks/${stackConfig.name}/compose.yml`
    try {
      composeContents.push(await Deno.readTextFile(composePath))
    } catch {
      // Compose file not found, skip
    }
  }
  return extractVolumePaths(composeContents, env)
}

// Functions extracted to ./src/+lib.ts:
//   extractVolumePaths, generateVolumeCreationScript, generateDeployScript,
//   parseDeployResults, printDeploySummary, getRemoteChecksums

// Helper function to recursively copy a directory
async function copyDirectory(src: string, dest: string): Promise<void> {
  // Create destination directory if it doesn't exist
  await Deno.mkdir(dest, { recursive: true })

  for await (const entry of Deno.readDir(src)) {
    const srcPath = `${src}/${entry.name}`
    const destPath = `${dest}/${entry.name}`

    if (entry.isDirectory) {
      await copyDirectory(srcPath, destPath)
    } else if (entry.isFile) {
      await Deno.copyFile(srcPath, destPath)
    }
  }
}
