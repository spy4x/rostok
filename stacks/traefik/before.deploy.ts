// Copies server-specific Traefik dynamic config files into the dynamic/
// directory before deployment. This allows per-server overrides (e.g.,
// authelia middleware + opencode-web route on home) while keeping a shared
// base config (00-base.yml) used by all servers.
//
// Also substitutes ${ENV_VAR} placeholders in all YAML files with values
// from the deployment environment (e.g., BASIC_AUTH_USER, BASIC_AUTH_PASSWORD).
//
// Expected file location on server:
//   configs/traefik/dynamic/*.yml  →  stacks/traefik/dynamic/*.yml

const configSource = "configs/traefik/dynamic"

function substituteEnvVars(content: string): string {
  return content.replace(/\$\{([^}]+)\}/g, (_match, varName) => {
    const value = Deno.env.get(varName.trim())
    if (value === undefined) {
      console.warn(`Warning: env var '${varName}' not found, leaving placeholder`)
      return _match
    }
    return value
  })
}

// Process all YAML files in the dynamic directory
async function processFile(filePath: string): Promise<void> {
  const content = await Deno.readTextFile(filePath)
  const substituted = substituteEnvVars(content)
  await Deno.writeTextFile(filePath, substituted)
}

// Process the base config
const baseFiles = ["stacks/traefik/dynamic/00-base.yml"]
for (const file of baseFiles) {
  try {
    await Deno.stat(file)
    await processFile(file)
    console.log(`Substituted env vars in ${file}`)
  } catch {
    console.log(`${file} not found, skipping`)
  }
}

// Copy server-specific config if present
try {
  const entries: Deno.DirEntry[] = []
  for await (const entry of Deno.readDir(configSource)) {
    entries.push(entry)
  }

  if (entries.length > 0) {
    const destDir = "stacks/traefik/dynamic"
    for (const entry of entries) {
      if (entry.isFile && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))) {
        const destPath = `${destDir}/${entry.name}`
        await Deno.copyFile(`${configSource}/${entry.name}`, destPath)
        await processFile(destPath)
        console.log(`Copied and substituted ${configSource}/${entry.name} → ${destPath}`)
      }
    }
  } else {
    console.log(`No server-specific Traefik configs found in ${configSource}`)
  }
} catch (err) {
  if (err instanceof Deno.errors.NotFound) {
    console.log(`No server-specific Traefik configs (${configSource} not found)`)
  } else {
    throw err
  }
}
