// Copies server-specific Traefik dynamic config files into the dynamic/
// directory before deployment. This allows per-server overrides (e.g.,
// authelia middleware + openhands route on home) while keeping a shared
// base config (00-base.yml) used by all servers.
//
// Expected file location on server:
//   configs/traefik/dynamic/*.yml  →  stacks/traefik/dynamic/*.yml

const configSource = "configs/traefik/dynamic"

try {
  const entries: Deno.DirEntry[] = []
  for await (const entry of Deno.readDir(configSource)) {
    entries.push(entry)
  }

  if (entries.length === 0) {
    console.log(`No server-specific Traefik configs found in ${configSource}, skipping`)
    Deno.exit(0)
  }

  const destDir = "stacks/traefik/dynamic"
  for (const entry of entries) {
    if (entry.isFile && entry.name.endsWith(".yml")) {
      await Deno.copyFile(`${configSource}/${entry.name}`, `${destDir}/${entry.name}`)
      console.log(`Copied ${configSource}/${entry.name} → ${destDir}/${entry.name}`)
    }
  }
} catch (err) {
  if (err instanceof Deno.errors.NotFound) {
    console.log(`No server-specific Traefik configs (${configSource} not found), skipping`)
  } else {
    throw err
  }
}
