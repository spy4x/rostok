// Copies the server's own Traefik files, `configs/pangolin/dynamic/*.yml`, next to the catalog's
// `00-pangolin.yml` in `stacks/pangolin/traefik/dynamic/`, the directory the Pangolin Traefik
// reads (`traefik/traefik_config.yml`, file provider). This is how a server adds routers and
// middlewares for Pangolin hosts, for example a different login in front of one resource,
// without a host name in the catalog.
//
// A missing or empty `configs/pangolin/dynamic/` is fine: the deploy then ships the catalog file
// only. The files are copied, not bind-mounted: Docker cannot mount a single file into a
// read-only directory mount, and the Pangolin Traefik needs both in one directory.

const DYNAMIC_DIR = "stacks/pangolin/traefik/dynamic"
const CONFIG_SOURCE = "configs/pangolin/dynamic"

/** Whether a file name is a Traefik dynamic config the provider should load. */
export function isDynamicConfigName(name: string): boolean {
  return name.endsWith(".yml") || name.endsWith(".yaml")
}

/**
 * Copy every `.yml`/`.yaml` file of `source` into `dest` and return the copied names.
 * A missing `source` returns an empty list. Never copies over the catalog's `00-pangolin.yml`:
 * that name is refused, so a server file cannot replace the base.
 */
export async function copyServerConfigs(source: string, dest: string): Promise<string[]> {
  const copied: string[] = []
  let entries: Deno.DirEntry[]
  try {
    entries = await Array.fromAsync(Deno.readDir(source))
  } catch (err) {
    // Only a missing source is fine; a missing destination must fail the deploy below.
    if (err instanceof Deno.errors.NotFound) return []
    throw err
  }
  for (const entry of entries) {
    // Plain files only: a symlink could point outside the server's folder.
    if (!entry.isFile || entry.isSymlink || !isDynamicConfigName(entry.name)) continue
    if (entry.name === "00-pangolin.yml") {
      throw new Error(`${source}/${entry.name} would replace the catalog's base file; rename it`)
    }
    await Deno.copyFile(`${source}/${entry.name}`, `${dest}/${entry.name}`)
    copied.push(entry.name)
  }
  return copied
}

if (import.meta.main) {
  try {
    const copied = await copyServerConfigs(CONFIG_SOURCE, DYNAMIC_DIR)
    if (copied.length === 0) {
      console.log(`No server-specific Pangolin Traefik configs in ${CONFIG_SOURCE}`)
    }
    for (const name of copied) {
      console.log(`Copied ${CONFIG_SOURCE}/${name} → ${DYNAMIC_DIR}/${name}`)
    }
  } catch (err) {
    console.error("before.deploy.ts FAILED:", err instanceof Error ? err.message : String(err))
    Deno.exit(1)
  }
}
