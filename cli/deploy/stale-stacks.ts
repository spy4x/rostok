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
    // Prints a name that failed validation with every byte outside a
    // plain allow-list replaced by `?`, so a directory name or label
    // planted on the server can't send escape sequences or a fake
    // line (a newline) to the operator's terminal.
    "printable() {",
    "  printf '%s' \"$1\" | tr -c 'A-Za-z0-9._ -' '?'",
    "}",
    "",
    // A stop-and-remove for one stack name, called for every stale name
    // discovered below (whether from a directory listing or, for a
    // folder that's already gone, from a container label scan). Reused
    // for both, so there's exactly one code path that ever stops a
    // container or removes a folder — never two that could drift.
    // Returns non-zero on ANY failure (a stop that failed, or an rm
    // that failed) — never on a name it merely decided to skip (that's
    // reported and treated as handled, not as this stack's failure).
    // Callers (both phases) must check this return value: a piped
    // `while` loop's own `exit`/`return` only ever escapes the SUBSHELL
    // that loop runs in, never the calling shell, so a caller that
    // ignores the return value would silently keep going past a stop
    // that never actually happened (review round).
    "stop_and_remove() {",
    '  name="$1"',
    // Defence in depth: `name` only ever reaches here from this
    // script's own sources below (a real directory entry under
    // STACKS_DIR, or a label VALUE already checked against the same
    // pattern) — but a container's own labels are attacker-influenced
    // in theory (anyone with docker access on the remote can set them),
    // so re-validate the shape before it's used to build a
    // `docker ps --filter` value or an rm target. Reported, not silent
    // (review round): an operator staring at a cleanup run that skipped
    // something must be able to tell why.
    '  case "$name" in',
    "    ''|*[!A-Za-z0-9_-]*)",
    '      echo "skipped \'$(printable "$name")\': unsafe name"',
    "      return 0",
    "      ;;",
    "  esac",
    '  dir="$STACKS_DIR/$name"',
    // Every container whose OWN working_dir label equals this stack's
    // dir EXACTLY (never a prefix match — see the container-label scan
    // below for why that distinction matters), stopped via its compose
    // PROJECT label, never via `cd`+`docker compose down` (see the
    // module comment for why that fails for name:-setting stacks).
    // `seen` dedupes: several containers can share one project label,
    // and `docker compose -p <project> down` already stops all of a
    // project's containers in one call — calling it again per
    // container printed (and risked failing) once per CONTAINER instead
    // of once per project (review round: "smaller" item).
    "  seen=' '",
    '  if ! docker ps -a --filter "label=com.docker.compose.project.working_dir=$dir" ' +
    "--format '{{.ID}}|{{.Label \"com.docker.compose.project\"}}' 2>/dev/null | " +
    "while IFS='|' read -r id proj; do",
    '    case "$proj" in',
    "      ''|*[!A-Za-z0-9_.-]*) continue ;;",
    "    esac",
    '    case "$seen" in',
    '      *" $proj "*) continue ;;',
    "    esac",
    '    seen="$seen$proj "',
    '    if ! docker compose -p "$proj" down --remove-orphans; then',
    "      echo \"FAILED to stop project '$proj' for stale stack '$name'\"",
    "      exit 1",
    "    fi",
    "  done; then",
    // The stop failed: never remove the folder — the operator needs
    // its compose file to retry or investigate — and never print
    // "Removed"/"Stopped" (review round).
    `    echo "FAILED to stop stale stack '$name': its folder was left in place."`,
    "    FAILED=1",
    "    return 1",
    "  fi",
    // Absolute path, no trailing slash, `--` first — see the module
    // comment for why each of those three matters.
    '  if [ -e "$dir" ] || [ -L "$dir" ]; then',
    '    if ! rm -rf -- "$dir"; then',
    '      echo "FAILED to remove $dir"',
    "      FAILED=1",
    "      return 1",
    "    fi",
    `    echo "Removed stale stack '$name'. Data kept at '${volumesPath}/$name'."`,
    "  else",
    `    echo "Stopped stale stack '$name' (its folder was already gone). Data kept at ` +
    `'${volumesPath}/$name'."`,
    "  fi",
    "  return 0",
    "}",
    "",
    // Phase 1: every entry under STACKS_DIR not in the active list,
    // found via a STACKS_DIR-prefixed glob (never a bare `*` after a
    // `cd`) so an empty or missing STACKS_DIR never iterates a literal,
    // non-existent "*" — `[ -e "$entry" ] || [ -L "$entry" ]` is what
    // actually guards that: an unmatched glob stays a literal pattern in
    // every POSIX shell without nullglob, so this must never assume the
    // loop only ever sees real entries. No trailing slash on the glob
    // (review round): a trailing-slash glob (`*/`) silently drops
    // anything that isn't already a directory — including a FILE
    // symlink under stacks/ — before this loop ever sees it, which is
    // exactly the silent-skip the review flagged. `-L` (not just `-e`)
    // keeps a BROKEN symlink in scope too, so it gets the same reported
    // "not a directory" skip instead of vanishing from both checks.
    `for entry in ${quotedStacksDir}/*; do`,
    '  [ -e "$entry" ] || [ -L "$entry" ] || continue',
    '  dir_name="${entry##*/}"',
    '  if [ ! -d "$entry" ]; then',
    '    echo "skipped \'$(printable "$dir_name")\': not a directory"',
    "    continue",
    "  fi",
    '  case " ${dir_name} " in',
    `${keepArm}      *) stop_and_remove "$dir_name" || FAILED=1 ;;`,
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
    `${activePattern.length > 0 ? `        ${activePattern}) ;;\n` : ""
      // `|| exit 1` here is load-bearing, not decorative (review
      // round): this call runs inside a piped `while` loop, which
      // POSIX runs in its own subshell — a failure `stop_and_remove`
      // reports via its return value would otherwise be swallowed the
      // moment this iteration ends, never reaching the `done ||
      // FAILED=1` below. `exit 1` here terminates THIS subshell
      // immediately, which IS what that `done || FAILED=1` observes.
    }        *) stop_and_remove "$rel" || exit 1 ;;`,
    "      esac",
    "      ;;",
    "  esac",
    "done || FAILED=1",
    "",
    '[ "$FAILED" = 0 ]',
  ]
  return lines.join("\n")
}
