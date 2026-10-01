// Prepares the Pangolin Traefik's files in the staging copy, `stacks/pangolin/traefik/`, before
// they are synced to the server. Two steps:
//
// 1. Fills the catalog files' placeholders: `${PANGOLIN_DOMAIN}` (the dashboard host, in the
//    routers of `dynamic/00-pangolin.yml`) and `${CONTACT_EMAIL}` (the ACME account, in
//    `traefik_config.yml`). Traefik cannot read env vars in its static file, so the deploy writes
//    the values in. A missing or malformed value fails the deploy: a router with an empty host
//    would never match, and a value with a quote or backtick would break the rule or the YAML.
//
// 2. Copies the server's own Traefik files, `configs/pangolin/dynamic/*.yml`, next to the
//    catalog's `00-pangolin.yml` in `traefik/dynamic/`, the directory the Pangolin Traefik reads
//    (`traefik/traefik_config.yml`, file provider). This is how a server adds routers and
//    middlewares for Pangolin hosts, for example a different login in front of one resource,
//    without a host name in the catalog. Server files are copied as they are, never filled.
//
// A missing or empty `configs/pangolin/dynamic/` is fine: the deploy then ships the catalog file
// only. The files are copied, not bind-mounted: Docker cannot mount a single file into a
// read-only directory mount, and the Pangolin Traefik needs both in one directory.

const TRAEFIK_DIR = "stacks/pangolin/traefik"
const DYNAMIC_DIR = `${TRAEFIK_DIR}/dynamic`
const CONFIG_SOURCE = "configs/pangolin/dynamic"
/** Catalog files that carry placeholders, relative to `traefik/`. */
export const FILLED_FILES = ["traefik_config.yml", "dynamic/00-pangolin.yml"]

const HOST_RE =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/i
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

/** The values the catalog's Pangolin Traefik files need. */
export interface TraefikValues {
  PANGOLIN_DOMAIN: string
  CONTACT_EMAIL: string
}

/**
 * Read and check PANGOLIN_DOMAIN and CONTACT_EMAIL. Pure, so every branch is testable.
 * Throws, naming the key, when one is missing or is not a plain host name or address.
 */
export function resolveTraefikValues(
  getEnv: (key: string) => string | undefined,
): TraefikValues {
  const domain = getEnv("PANGOLIN_DOMAIN")?.trim() ?? ""
  const email = getEnv("CONTACT_EMAIL")?.trim() ?? ""
  if (!domain) throw new Error("PANGOLIN_DOMAIN is not set")
  if (!HOST_RE.test(domain)) throw new Error("PANGOLIN_DOMAIN is not a plain host name")
  if (!email) throw new Error("CONTACT_EMAIL is not set")
  if (!EMAIL_RE.test(email)) throw new Error("CONTACT_EMAIL is not a plain e-mail address")
  return { PANGOLIN_DOMAIN: domain, CONTACT_EMAIL: email }
}

/**
 * Replace every `${PANGOLIN_DOMAIN}` and `${CONTACT_EMAIL}` in `text`. Throws when any other
 * `${...}` is left, so a placeholder this hook does not know never reaches Traefik as text.
 */
export function fillPlaceholders(text: string, values: TraefikValues): string {
  const filled = text.replace(
    /\$\{(PANGOLIN_DOMAIN|CONTACT_EMAIL)\}/g,
    (_, key: keyof TraefikValues) => values[key],
  )
  const left = /\$\{[^}]*\}/.exec(filled)
  if (left) throw new Error(`unknown placeholder ${left[0]}`)
  return filled
}

/** Fill the placeholders of every `FILLED_FILES` entry under `traefikDir`, in place. */
export async function fillCatalogFiles(traefikDir: string, values: TraefikValues): Promise<void> {
  for (const rel of FILLED_FILES) {
    const path = `${traefikDir}/${rel}`
    try {
      await Deno.writeTextFile(path, fillPlaceholders(await Deno.readTextFile(path), values))
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new Error(`${path}: ${reason}`)
    }
  }
}

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
    await fillCatalogFiles(TRAEFIK_DIR, resolveTraefikValues((key) => Deno.env.get(key)))
    console.log(`Filled PANGOLIN_DOMAIN and CONTACT_EMAIL into ${FILLED_FILES.join(", ")}`)
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
