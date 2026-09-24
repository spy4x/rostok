// Removes stacks that `config.json` no longer lists, before any file
// sync touches the remote (#233 point 4).
//
// The old cleanup ran AFTER rsync and only ever did `rm -rf` on the
// stack's folder — the containers kept running, unmanaged, and nothing
// ever stopped them. Two problems with running it after rsync, now that
// a full deploy syncs `PATH_APPS` with `--delete` (run-deploy.ts): by the
// time this script would run, rsync could already have deleted the
// folder itself, and stopping containers needs to happen before that.
//
// (Review round) `cd`-ing into the stack's own folder and running plain
// `docker compose down` there does NOT reliably stop the right
// containers: docker compose reads a `name:` field from `compose.yml`
// itself when one is set (22 of the catalog's ~50 stacks set
// `name: ${PROJECT}`), and a bare copy of that file — with no `.env` in
// the same folder to resolve `${PROJECT}` from — resolves to an empty
// or wrong project name, so `down` silently fails to find the actual
// running containers (deployed under `-p <deployAs>`,
// deploy-script.ts's own `-p` flag). Confirmed directly against a real
// `docker compose`: a stack invoked as `cd PATH_APPS && docker compose
// -p <name> -f stacks/<name>/compose.yml up` sets
// `com.docker.compose.project.working_dir` to `PATH_APPS/stacks/<name>`
// — the directory of the FIRST `-f` file, not the process's own cwd,
// and unaffected by a later `-f compose-override/<name>.yml` override.
//
// So this script never runs `docker compose down` inside a folder. It
// finds every container whose OWN `com.docker.compose.project.working_dir`
// label equals the stale stack's directory, reads its
// `com.docker.compose.project` label back, and stops it with
// `docker compose -p <project> down --remove-orphans` — that form needs
// no compose file at all, so it works identically whether the stack's
// folder still exists or was already removed by hand (or by an older
// rostok version's rm-only cleanup). `VOLUMES_PATH/<stack>` is never
// referenced by any command here — only named in the printed message —
// so app data always survives.
//
// `rm -rf` always gets the stack's ABSOLUTE directory with NO trailing
// slash, and `--` ahead of it (#233 review): a trailing slash makes
// `rm` (and a shell glob that finds the entry with one) FOLLOW a
// symlink into whatever it points at instead of unlinking the symlink
// itself — confirmed directly: `rm -rf "$dir/"` on a stack folder
// that's actually a symlink into VOLUMES_PATH deleted the real data
// inside the symlink's target; `rm -rf -- "$dir"` (no trailing slash)
// does not, and `--` stops a name that happens to start with "-" from
// being read as an option.

import { shQuote } from "./exec.ts"

/**
 * Build the remote shell script that stops and removes every stack
 * folder under `${pathApps}/stacks/` that `activeStackNames` (the FULL
 * config.json list, never a single-stack deploy's filtered one) doesn't
 * name, plus any container left behind by an already-missing folder.
 * `pathApps` must already be validated AND normalised (server-keys.ts's
 * validateRemotePath/normalizeRemotePath) — this only re-quotes it for
 * the shell, never re-checks its shape.
 *
 * The script exits non-zero if any stop or removal failed — the caller
 * must treat that as a real failure, not a warning to print and ignore;
 * a stack that couldn't be stopped is still running, unmanaged.
 */
export function generateStaleStackCleanupScript(
  activeStackNames: string[],
  pathApps: string,
  volumesPath: string,
): string {
  const stacksDir = `${pathApps}/stacks`
  const quotedStacksDir = shQuote(stacksDir)
  // " name1 |name2 | name3 " style case pattern, spaces included, so
  // "traefik" doesn't also match a folder named "traefik-old". An empty
  // list (config.json names no stacks at all) gets no "keep this one"
  // arm at all, so every folder correctly counts as stale.
  const activePattern = activeStackNames.map((s) => shQuote(` ${s} `)).join("|")
  const keepArm = activePattern.length > 0 ? `        ${activePattern}) ;;\n` : ""

  const lines = [
    "set -u",
    `STACKS_DIR=${quotedStacksDir}`,
    "FAILED=0",
    "",
    // A stop-and-remove for one stack name, called for every stale name
    // discovered below (whether from a directory listing or, for a
    // folder that's already gone, from a container label scan). Reused
    // for both, so there's exactly one code path that ever stops a
    // container or removes a folder — never two that could drift.
    "stop_and_remove() {",
    '  name="$1"',
    // Defence in depth: `name` only ever reaches here from this
    // script's own sources below (a real directory entry under
    // STACKS_DIR, or a label VALUE already checked against the same
    // pattern) — but a container's own labels are attacker-influenced
    // in theory (anyone with docker access on the remote can set them),
    // so re-validate the shape before it's used to build a
    // `docker ps --filter` value or an rm target.
    '  case "$name" in',
    "    ''|*[!A-Za-z0-9_-]*) return 0 ;;",
    "  esac",
    '  dir="$STACKS_DIR/$name"',
    // Every container whose OWN working_dir label equals this stack's
    // dir EXACTLY (never a prefix match — see the container-label scan
    // below for why that distinction matters), stopped via its compose
    // PROJECT label, never via `cd`+`docker compose down` (see the
    // module comment for why that fails for name:-setting stacks).
    '  docker ps -a --filter "label=com.docker.compose.project.working_dir=$dir" ' +
    "--format '{{.ID}}|{{.Label \"com.docker.compose.project\"}}' 2>/dev/null | " +
    "while IFS='|' read -r id proj; do",
    '    case "$proj" in',
    "      ''|*[!A-Za-z0-9_.-]*) continue ;;",
    "    esac",
    '    if ! docker compose -p "$proj" down --remove-orphans; then',
    "      echo \"FAILED to stop project '$proj' for stale stack '$name'\"",
    "      exit 1",
    "    fi",
    "  done || FAILED=1",
    // Absolute path, no trailing slash, `--` first — see the module
    // comment for why each of those three matters.
    '  if [ -e "$dir" ] || [ -L "$dir" ]; then',
    '    if ! rm -rf -- "$dir"; then',
    '      echo "FAILED to remove $dir"',
    "      FAILED=1",
    "    else",
    `      echo "Removed stale stack '$name'. Data kept at '${volumesPath}/$name'."`,
    "    fi",
    "  else",
    `    echo "Stopped stale stack '$name' (its folder was already gone). Data kept at ` +
    `'${volumesPath}/$name'."`,
    "  fi",
    "}",
    "",
    // Phase 1: every directory entry under STACKS_DIR not in the active
    // list, found via a STACKS_DIR-prefixed glob (never a bare `*/`
    // after a `cd`) so an empty or missing STACKS_DIR never iterates a
    // literal, non-existent "*" — `[ -e "$entry" ]` is what actually
    // guards that: an unmatched glob stays a literal pattern in every
    // POSIX shell without nullglob, so this must never assume the loop
    // only ever sees real entries.
    `for entry in ${quotedStacksDir}/*/; do`,
    '  [ -e "$entry" ] || continue',
    '  dir_name="${entry%/}"',
    '  dir_name="${dir_name##*/}"',
    '  case " ${dir_name} " in',
    `${keepArm}      *) stop_and_remove \"$dir_name\" ;;`,
    "  esac",
    "done",
    "",
    // Phase 2: a container whose working_dir sits under STACKS_DIR but
    // whose folder is already gone (phase 1's `[ -e ]` guard skipped it
    // entirely) — found by prefix, then the exact stack name is derived
    // and re-checked against the active list before stop_and_remove
    // (which itself re-validates it, and re-matches working_dir
    // EXACTLY) ever touches it.
    "docker ps -a --filter 'label=com.docker.compose.project.working_dir' " +
    "--format '{{.Label \"com.docker.compose.project.working_dir\"}}' 2>/dev/null | " +
    "while IFS= read -r wd; do",
    '  case "$wd" in',
    `    ${quotedStacksDir}/*)`,
    `      rel=\${wd#${quotedStacksDir}/}`,
    '      case "$rel" in */*) continue ;; esac',
    '      case " $rel " in',
    `${
      activePattern.length > 0 ? `        ${activePattern}) ;;\n` : ""
    }        *) stop_and_remove \"$rel\" ;;`,
    "      esac",
    "      ;;",
    "  esac",
    "done || FAILED=1",
    "",
    '[ "$FAILED" = 0 ]',
  ]
  return lines.join("\n")
}
