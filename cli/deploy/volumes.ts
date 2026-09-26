// Volume-directory provisioning (#206 deploy side).
//
// `generateVolumeCreationScript` used to chown to a user *name* and
// swallow failures (`|| true`, `2>/dev/null`) — a `chown` failure left
// directories owned by `root`, Traefik couldn't write `acme.json`, and
// deploy still printed "Volume directories created". It now chowns to
// `PUID:PGID` (the IDs the containers actually run as) and fails the
// deploy loudly, with the remote error, when mkdir or chown fails. The
// caller decides whether `sudo -n` is needed from the remote's actual
// `id -u` (see docker-preflight.ts's `needsRemoteSudo`), not from the
// SSH_USER string — `ssh root@host` logs in as root regardless of what
// SSH_USER says. A missing passwordless-sudo rule then surfaces as a
// clear deploy error instead of a silent permission failure.
//
// Every value below comes from `.env` or a compose file, so it's quoted
// with `shQuote` (single quotes) before going into the remote script —
// double quotes would still let `$(...)`/backticks run.
//
// (#249) A deploy user that isn't root runs `sudo -n` only for a folder
// that is missing or not owned by `PUID:PGID` yet. A folder that already
// exists with the right owner needs no change, so a user without
// passwordless sudo can still deploy a stack whose volume folders were
// prepared once by an admin.
//
// (#250) A volume path with a `..` component, or one that doesn't stay
// strictly inside VOLUMES_PATH, is refused: it would otherwise reach
// `sudo chown -R` and could take over any folder on the server, such as
// `/etc`.
//
// (#257) The `..` check above reads only the path text. A folder partway
// along the path can still be a symlink on the server, and `mkdir -p` or
// `chown -R` would follow it out of VOLUMES_PATH. Before either runs,
// the generated script resolves the path on the server: it finds the
// deepest part of the path that already exists, resolves it with
// `cd -P` + `pwd -P` (POSIX, so busybox, dash, bash and zsh all behave
// the same, unlike `realpath -m`, which busybox lacks), and refuses the
// path unless the result stays strictly inside the resolved
// VOLUMES_PATH. mkdir and chown then act on that resolved path, and the
// path is resolved and checked again between mkdir and chown, all in the
// same remote shell. For a deploy user that isn't root, the check runs
// inside the same `sudo -n sh -c` as the mkdir and chown it guards: with
// the user's own rights, `cd` fails on a folder it may not enter (umask
// 027, a PUID-owned mode-700 folder) that sudo can still create or chown.
// The paths reach that `sh -c` as positional arguments, never inside the
// script text.
//
// (#258) A stack's `+meta.ts` can declare `fileMounts`: volume paths
// that are files, such as traefik's `acme.json`. The volume script never
// targets them with mkdir or chown. `generateFileMountCheckScript`
// checks, in a separate read-only call that deploy makes before stale
// cleanup, file sync or any container change, that each one is a
// regular file, and deploy stops otherwise: Docker creates a folder in
// place of a missing bind-mount source, so skipping a missing file would
// still end with a folder named `acme.json`.

import { shQuote } from "./exec.ts"
import { UserError } from "../errors.ts"
import { pathComponents } from "../server-keys.ts"
import { validateStackMeta } from "../stack-meta.ts"
import { loadCatalog } from "../catalog.ts"

/**
 * Throw a UserError unless `path` is a real subfolder of `volumesPath`:
 * no `..` component anywhere, and inside `volumesPath` (never equal to
 * it) after normalising doubled slashes and `.` segments.
 */
function assertInsideVolumesPath(path: string, volumesPath: string): void {
  const components = path.split("/")
  if (components.includes("..")) {
    throw new UserError(
      `volume path "${path}" contains a ".." component — a compose volume must stay inside ` +
        `VOLUMES_PATH (${volumesPath}). Fix the stack's compose.yml or the variable it uses.`,
    )
  }
  const base = pathComponents(volumesPath)
  const target = pathComponents(path)
  const inside = target.length > base.length && base.every((c, i) => target[i] === c)
  if (!inside) {
    throw new UserError(
      `volume path "${path}" is not a subfolder of VOLUMES_PATH (${volumesPath}). ` +
        `Fix the stack's compose.yml or the variable it uses.`,
    )
  }
}

/**
 * Extract every `${VOLUMES_PATH}/...` reference from a set of compose
 * files. Throws a UserError for a path that would leave VOLUMES_PATH
 * (see `assertInsideVolumesPath`), before any command is built from it.
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
      const volumesPath = env["VOLUMES_PATH"] || "${VOLUMES_PATH}"
      const fullPath = `${volumesPath}/${expandedPath}`
      assertInsideVolumesPath(fullPath, volumesPath)
      volumePaths.add(fullPath)
    }
  }

  return Array.from(volumePaths)
}

/**
 * How to fix a local `+meta.ts` that fails to import. The installed
 * rostok CLI imports it without the project's `deno.jsonc`, so a bare
 * `@rostok/cli` import resolves only when it is `import type` (erased
 * at run time); a value such as `generatePassword` must come from the
 * full JSR specifier.
 */
const META_IMPORT_HINT = `A project's own +meta.ts is imported without the project's deno.jsonc: ` +
  `use \`import type\` for "@rostok/cli", and import values such as generatePassword ` +
  `from "jsr:@rostok/cli/lib".`

/**
 * The `fileMounts` a stack declares in its `+meta.ts`, relative to
 * VOLUMES_PATH. `files` is the stack's resolved deploy files
 * (stack-files.ts): a local `stacks/<name>/+meta.ts` is imported from
 * there; a stack without one uses the bundled catalog's `+meta.ts`, and
 * a stack in neither has no file mounts. A local `+meta.ts` that fails
 * to load falls back to the catalog's with a warning, or throws a
 * UserError for a stack the catalog doesn't know: guessing "no file
 * mounts" there could turn a file mount into a folder.
 */
export async function loadStackFileMounts(
  stackName: string,
  files: Map<string, string>,
): Promise<string[]> {
  const bundled = loadCatalog().find((e) => e.name === stackName)?.meta
  const metaUrl = files.get("+meta.ts")
  if (!metaUrl) return bundled?.fileMounts ?? []
  try {
    const mod = await import(metaUrl)
    return validateStackMeta(mod.default).fileMounts ?? []
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (!bundled) {
      throw new UserError(
        `could not load stacks/${stackName}/+meta.ts to read its fileMounts: ${reason}. ` +
          META_IMPORT_HINT,
      )
    }
    console.warn(
      `Warning: could not load stacks/${stackName}/+meta.ts (${reason}); ` +
        `using the bundled catalog's fileMounts for ${stackName} instead. ${META_IMPORT_HINT}`,
    )
    return bundled.fileMounts ?? []
  }
}

/** What `generateVolumeCreationScript` needs to build the remote script. */
export interface VolumeScriptOptions {
  /** VOLUMES_PATH on the server; every path must resolve strictly inside it. */
  volumesPath: string
  /** Every volume path from the compose files (`extractVolumePaths`). */
  volumePaths: string[]
  /** Absolute paths of volumes that are files (from `fileMounts`), not folders. */
  fileMounts: string[]
  puid: string
  pgid: string
  /** True when the remote user isn't root, so mkdir/chown go through `sudo -n`. */
  needsSudo: boolean
}

/**
 * Shell functions for the volume script. `rostok_base_init V` resolves
 * VOLUMES_PATH into `rostok_base` and `rostok_prefix` (`rostok_base/`).
 * `rostok_resolve P` sets `rostok_real` to P's resolved path, or prints
 * why and fails when P would leave the resolved VOLUMES_PATH. Every
 * variable is quoted, so they behave the same in sh and in zsh, which
 * doesn't split words.
 */
const RESOLVE_FUNCTIONS = `rostok_base_init() {
  rostok_base=$(cd -P -- "$1" >/dev/null && pwd -P && echo x) || return 1
  rostok_base=\${rostok_base%x}
  rostok_base=\${rostok_base%?}
  case $rostok_base in /) rostok_prefix=/ ;; *) rostok_prefix=$rostok_base/ ;; esac
}
rostok_resolve() {
  rostok_d=$1
  while [ ! -e "$rostok_d" ] && [ ! -L "$rostok_d" ]; do
    rostok_up=\${rostok_d%/*}
    [ -z "$rostok_up" ] && rostok_up=/
    [ "$rostok_up" = "$rostok_d" ] && break
    rostok_d=$rostok_up
  done
  if [ ! -d "$rostok_d" ]; then
    printf 'rostok: volume path %s: %s is not a folder (a file, a broken symlink or missing), refusing to create or chown it\\n' "$1" "$rostok_d" >&2
    return 1
  fi
  rostok_real=$(cd -P -- "$rostok_d" >/dev/null && pwd -P && echo x) || return 1
  rostok_real=\${rostok_real%x}
  rostok_real=\${rostok_real%?}
  [ "$rostok_real" = / ] && rostok_real=
  rostok_real=$rostok_real\${1#"$rostok_d"}
  case $rostok_real in
    "$rostok_prefix"?*) return 0 ;;
  esac
  printf 'rostok: volume path %s resolves to %s, outside VOLUMES_PATH (%s), refusing to create or chown it\\n' "$1" "$rostok_real" "$rostok_base" >&2
  return 1
}`

/**
 * The script `sudo -n sh -c` runs for one folder: `$1` is the volume
 * path, `$2` the `uid:gid` owner, `$3` VOLUMES_PATH. A constant, so no
 * value from `.env` or a compose file is ever part of the script text.
 */
const SUDO_FOLDER_SCRIPT = `${RESOLVE_FUNCTIONS}
rostok_base_init "$3" && rostok_resolve "$1" && mkdir -p -- "$rostok_real" &&
rostok_resolve "$1" && chown -R "$2" -- "$rostok_real"`

/** Prints why and fails unless `$1` is a regular file. */
const FILE_FUNCTION = `rostok_file() {
  [ -f "$1" ] && return 0
  if [ -e "$1" ] || [ -L "$1" ]; then
    printf 'rostok: file mount %s exists but is not a regular file. Remove it (an older deploy may have created it as a folder), then deploy again\\n' "$1" >&2
  else
    printf 'rostok: file mount %s does not exist yet. Deploy the stack that creates it first, then deploy again (rostok never creates it: Docker would mount a folder in its place)\\n' "$1" >&2
  fi
  return 1
}`

/** `path` normalised for comparison: doubled slashes and `.` segments dropped. */
function pathKey(path: string): string {
  return pathComponents(path).join("/")
}

/** The declared file mounts that a compose file actually mounts. */
function fileMountsInUse(volumePaths: string[], fileMounts: string[]): string[] {
  const declared = new Set(fileMounts.map(pathKey))
  return volumePaths.filter((p) => declared.has(pathKey(p)))
}

/**
 * Build the read-only remote script that checks every file mount a
 * compose file uses is already a regular file, or "" when there is none.
 * Deploy runs it before stale cleanup, file sync or any container change,
 * so a missing file stops the deploy before it touches a stack.
 *
 * A user that isn't root first tests the file with its own rights and
 * falls back to `sudo -n sh -c` (the path passed as `$1`) only when that
 * test fails, e.g. because a folder on the way is mode 700: it only reads.
 */
export function generateFileMountCheckScript(
  opts: Pick<VolumeScriptOptions, "volumePaths" | "fileMounts" | "needsSudo">,
): string {
  const mounts = fileMountsInUse(opts.volumePaths, opts.fileMounts)
  if (mounts.length === 0) return ""
  if (!opts.needsSudo) {
    return `${FILE_FUNCTION}\n${mounts.map((p) => `rostok_file ${shQuote(p)}`).join(" &&\n")}\n`
  }
  const sudoScript = shQuote(`${FILE_FUNCTION}\nrostok_file "$1"`)
  return mounts
    .map((p) => `( [ -f ${shQuote(p)} ] || sudo -n sh -c ${sudoScript} sh ${shQuote(p)} )`)
    .join(" &&\n") + "\n"
}

/**
 * Build the remote script that creates and chowns every volume folder
 * (every volume path except the file mounts) to `puid:pgid`. Any failure
 * fails the whole script and its stderr reaches the caller: nothing is
 * hidden behind `|| true` or `2>/dev/null`.
 *
 * As root (`needsSudo` false), each folder is resolved and checked
 * (`rostok_resolve`, see the module comment), then gets `mkdir -p` and
 * `chown -R` on its resolved path.
 *
 * Otherwise each folder is wrapped as `( [ -d P ] && [ "$(stat -c %u:%g
 * P)" = U:G ] || sudo -n sh -c SCRIPT sh P U:G V )`. The first half is the
 * #249 fast path: a folder that already exists with the right owner
 * needs nothing privileged, so no check is needed either, and a user
 * without passwordless sudo can still deploy. Anything else runs the
 * check, mkdir and chown as root in one `sh -c` (`SUDO_FOLDER_SCRIPT`).
 * The subshell keeps the `&&` chain between paths intact: without it,
 * `a && [ -d P ] || b && c` would parse as `((a && [ -d P ]) || b) && c`,
 * and a failure of `a` would run `b` instead of stopping (the same reason
 * #248 wrapped the VOLUMES_PATH mkdir in docker-preflight.ts).
 */
export function generateVolumeCreationScript(opts: VolumeScriptOptions): string {
  const owner = `${shQuote(opts.puid)}:${shQuote(opts.pgid)}`
  const base = shQuote(opts.volumesPath)
  const files = new Set(fileMountsInUse(opts.volumePaths, opts.fileMounts))
  const folders = opts.volumePaths.filter((p) => !files.has(p))
  if (!opts.needsSudo) {
    const steps = [`rostok_base_init ${base}`]
    for (const path of folders) {
      const p = shQuote(path)
      const r = `"$rostok_real"`
      steps.push(
        `rostok_resolve ${p} && mkdir -p -- ${r} && rostok_resolve ${p} && chown -R ${owner} -- ${r}`,
      )
    }
    return `${RESOLVE_FUNCTIONS}\n${steps.join(" &&\n")}\n`
  }
  const sudoScript = shQuote(SUDO_FOLDER_SCRIPT)
  return folders.map((path) => {
    const p = shQuote(path)
    // `[ ! -L ]`: `stat` without -L reads a symlink's own owner, so a
    // PUID-owned link to `/etc` would otherwise skip the sudo check.
    return `( [ -d ${p} ] && [ ! -L ${p} ] && [ "$(stat -c %u:%g -- ${p})" = ${owner} ] || ` +
      `sudo -n sh -c ${sudoScript} sh ${p} ${owner} ${base} )`
  }).join(" &&\n") + "\n"
}
