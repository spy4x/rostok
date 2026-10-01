/**
 * Where a running compose stack really came from, read from the labels
 * `docker compose` puts on every container it creates. The backup stops and
 * restarts a stack with exactly these values, never with a path derived from
 * the runner's own `PATH_APPS`: after a server moves to the rostok layout, that
 * path is an old checkout with a stale compose file (#297).
 */
export interface ComposeTarget {
  /** `com.docker.compose.project` */
  project: string
  /** `com.docker.compose.project.config_files`, split on commas */
  configFiles: string[]
  /**
   * `com.docker.compose.project.working_dir`. Real compose sets it to the first
   * compose file's directory (`<apps>/stacks/<name>`), NOT to where
   * `rostok deploy` ran, so it is informational only.
   */
  workingDir: string
  /**
   * The apps root: the part of the stack's compose file before
   * `/stacks/<dir>/compose.yml`. `rostok deploy` runs compose from here and
   * keeps `.env.root` and `.env` here.
   */
  appsRoot: string
}

/** The `docker ps --format` template that `parseComposeTargets` reads. */
export const COMPOSE_LABELS_FORMAT = [
  `{{.Label "com.docker.compose.project"}}`,
  `{{.Label "com.docker.compose.project.config_files"}}`,
  `{{.Label "com.docker.compose.project.working_dir"}}`,
].join("\t")

/**
 * Parses `docker ps --format COMPOSE_LABELS_FORMAT` output and returns the
 * distinct compose targets whose compose files include
 * `<anything>/stacks/<stackDir>/compose.yml`. Containers without compose
 * labels are skipped.
 */
export function parseComposeTargets(psOutput: string, stackDir: string): ComposeTarget[] {
  const suffix = `/stacks/${stackDir}/compose.yml`
  const found = new Map<string, ComposeTarget>()
  for (const line of psOutput.split("\n")) {
    const [project, files, workingDir] = line.split("\t").map((part) => part.trim())
    if (!project || !files || !workingDir) continue
    const configFiles = files.split(",").map((file) => file.trim()).filter(Boolean)
    const own = configFiles.find((file) => file.endsWith(suffix))
    if (!own) continue
    const appsRoot = own.slice(0, -suffix.length)
    found.set(JSON.stringify([project, configFiles, workingDir]), {
      project,
      configFiles,
      workingDir,
      appsRoot,
    })
  }
  return [...found.values()]
}

/**
 * Compose containers that look like they belong to the stack (project named
 * after the stack directory, or working dir `.../stacks/<stackDir>`) although
 * no compose file of theirs ends in `/stacks/<stackDir>/compose.yml`. Such a
 * stack cannot be stopped safely, so the caller must fail the backup.
 */
export function parseUnmatchedStackContainers(psOutput: string, stackDir: string): string[] {
  const suffix = `/stacks/${stackDir}/compose.yml`
  const names = new Set<string>()
  for (const line of psOutput.split("\n")) {
    const [project, files, workingDir] = line.split("\t").map((part) => part.trim())
    if (!project || !files) continue
    if (files.split(",").some((file) => file.trim().endsWith(suffix))) continue
    if (project === stackDir || workingDir?.endsWith(`/stacks/${stackDir}`)) {
      names.add(project)
    }
  }
  return [...names]
}

/** `-f` arguments for a target's compose files, in the order compose recorded them. */
export function composeFileArgs(target: ComposeTarget): string[] {
  return target.configFiles.flatMap((file) => ["-f", file])
}

/**
 * Checks that the target can be rebuilt faithfully by `up -d`: every compose
 * file still exists, and the `.env.root` and `.env` that `rostok deploy` passes
 * as `--env-file` (relative to the apps root) exist too. Returns the reason
 * it cannot, or `null` when it can.
 */
export async function whyCannotRebuild(target: ComposeTarget): Promise<string | null> {
  const required = [
    ...target.configFiles,
    `${target.appsRoot}/.env.root`,
    `${target.appsRoot}/.env`,
  ]
  const missing: string[] = []
  for (const path of required) {
    try {
      await Deno.stat(path)
    } catch {
      missing.push(path)
    }
  }
  return missing.length === 0 ? null : `missing: ${missing.join(", ")}`
}

/** Whether the apps root holds both env files that `rostok deploy` passes to compose. */
export async function hasDeployEnvFiles(target: ComposeTarget): Promise<boolean> {
  for (const name of [".env.root", ".env"]) {
    try {
      await Deno.stat(`${target.appsRoot}/${name}`)
    } catch {
      return false
    }
  }
  return true
}

/** Env-file arguments `rostok deploy` passes to `docker compose` (see cli/deploy/deploy-script.ts). */
export const DEPLOY_ENV_FILE_ARGS = ["--env-file=.env.root", "--env-file=.env"]
