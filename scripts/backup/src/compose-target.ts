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
  /**
   * `com.docker.compose.project.config_files`, split on commas. When the
   * stack's containers carry different lists, the one that contains all the
   * others (see `parseComposeTargets`).
   */
  configFiles: string[]
  /**
   * The apps root: the part of the stack's compose file before
   * `/stacks/<dir>/compose.yml`. `rostok deploy` runs compose from here and
   * keeps `.env.root` and `.env` here. Compose's own `working_dir` label is the
   * stack directory (`<apps>/stacks/<name>`), so it is not used.
   */
  appsRoot: string
}

/** The `docker ps --format` template that `parseComposeTargets` reads. */
export const COMPOSE_LABELS_FORMAT = [
  `{{.Label "com.docker.compose.project"}}`,
  `{{.Label "com.docker.compose.project.config_files"}}`,
  `{{.Label "com.docker.compose.project.working_dir"}}`,
].join("\t")

/** What `parseComposeTargets` found in `docker ps` output. */
export interface ParsedComposeTargets {
  /** One target per compose project and apps root. */
  targets: ComposeTarget[]
  /** Why a project's containers could not be merged into one target. */
  conflicts: string[]
}

/**
 * Parses `docker ps --format COMPOSE_LABELS_FORMAT` output and returns one
 * target per compose project and apps root among the containers whose compose
 * files include `<anything>/stacks/<stackDir>/compose.yml`. Containers without
 * a project or config files label are skipped.
 *
 * The containers of one project can carry different `config_files` labels:
 * `rostok deploy` adds `compose-override/<stack>.yml` after the stack's own
 * file, compose then recreates only the services the override changes, and
 * the others keep the shorter list (Watchtower copies the old labels too). So
 * the target uses the longest list, provided every other list is an ordered
 * subsequence of it. Lists that do not fit together are a conflict: no single
 * set of files reproduces every container.
 */
export function parseComposeTargets(psOutput: string, stackDir: string): ParsedComposeTargets {
  const suffix = `/stacks/${stackDir}/compose.yml`
  const groups = new Map<string, { project: string; appsRoot: string; lists: string[][] }>()
  for (const line of psOutput.split("\n")) {
    const [project, files] = line.split("\t").map((part) => part.trim())
    if (!project || !files) continue
    const configFiles = files.split(",").map((file) => file.trim()).filter(Boolean)
    const own = configFiles.find((file) => file.endsWith(suffix))
    if (!own) continue
    const appsRoot = own.slice(0, -suffix.length)
    const key = JSON.stringify([project, appsRoot])
    const group = groups.get(key) ?? { project, appsRoot, lists: [] }
    group.lists.push(configFiles)
    groups.set(key, group)
  }
  const targets: ComposeTarget[] = []
  const conflicts: string[] = []
  for (const { project, appsRoot, lists } of groups.values()) {
    const longest = lists.reduce((a, b) => b.length > a.length ? b : a)
    if (lists.every((list) => isOrderedSubsequence(list, longest))) {
      targets.push({ project, configFiles: longest, appsRoot })
      continue
    }
    const distinct = [...new Set(lists.map((list) => list.join(",")))]
    conflicts.push(
      `Containers of compose project ${project} in ${appsRoot} were created from compose ` +
        `files that do not fit together (${distinct.join(" | ")}), so no single set of files ` +
        `reproduces them. Recreate the stack from its current files (rostok deploy) first.`,
    )
  }
  return { targets, conflicts }
}

/** Whether every item of `part` occurs in `whole`, in the same order. */
function isOrderedSubsequence(part: string[], whole: string[]): boolean {
  let at = 0
  for (const item of part) {
    at = whole.indexOf(item, at) + 1
    if (at === 0) return false
  }
  return true
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
