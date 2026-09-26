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
 * `activeProjects` names extra compose projects the active stacks run
 * under (their `deployAs` values); a container labelled with one of
 * them, or with an active stack's own name, is never stopped.
 * `pathApps` and `volumesPath` must already be validated AND normalised (server-keys.ts's
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
  activeProjects: string[] = [],
): string {
  const stacksDir = `${pathApps}/stacks`
  const quotedStacksDir = shQuote(stacksDir)
  // " name1 |name2 | name3 " style case pattern, spaces included, so
  // "traefik" doesn't also match a folder named "traefik-old". An empty
  // list (config.json names no stacks at all) gets no "keep this one"
  // arm at all, so every folder correctly counts as stale.
  const activePattern = activeStackNames.map((s) => shQuote(` ${s} `)).join("|")
  const keepArm = activePattern.length > 0 ? `        ${activePattern}) ;;\n` : ""
  // Compose projects the active stacks run under: each stack's name
  // plus any `activeProjects` (a `deployAs` alias), deduplicated.
  const protectedProjects = [...new Set([...activeStackNames, ...activeProjects])]
  const protectedPattern = protectedProjects.map((p) => shQuote(` ${p} `)).join("|")
  const protectArm = protectedPattern.length > 0
    ? `    case " $proj " in\n      ${protectedPattern})\n` +
      `        echo "skipped project '$proj' for stale stack '$name': an active stack uses it"\n` +
      `        continue\n        ;;\n    esac`
    : ""

  const lines = [
    "set -u",
    // ssh invokes this script through the REMOTE user's login shell,
    // which is often zsh, not sh — this whole script must behave the
    // same way under both. zsh's default NOMATCH option makes an
    // unmatched glob (an empty STACKS_DIR/*, e.g. a fresh server) abort
    // the command outright ("zsh: no matches found: .../stacks/*")
    // instead of leaving the pattern as a literal word the way POSIX
    // sh/bash do — the `for` loop below would never even start.
    // `setopt nullglob` (zsh only, guarded by $ZSH_VERSION so this is a
    // silent no-op everywhere else) makes an unmatched glob expand to
    // ZERO words instead, which is what the loop actually wants.
    'if [ -n "${ZSH_VERSION:-}" ]; then setopt nullglob 2>/dev/null || true; fi',
    `STACKS_DIR=${quotedStacksDir}`,
    // Preflight's symlink check ran in an earlier SSH session (#250), so
    // STACKS_DIR could have been swapped for a symlink since. Every `rm`
    // below is rooted here: refuse before any of them runs.
    'if [ -L "$STACKS_DIR" ]; then',
    '  echo "FAILED: $STACKS_DIR is a symlink, refusing to clean up stale stacks."',
    "  exit 1",
    "fi",
    // Quoted once here, then only ever expanded as "$VOLUMES_SHOWN", so a
    // `$(...)` in the value is printed, never run.
    `VOLUMES_SHOWN=${shQuote(volumesPath)}`,
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
    // `docker ps` output is captured into a variable first, never piped
    // straight into the `while` below (#243 review): a plain
    // `docker ps ... | while ...; do ...; done` loses `docker ps`'s OWN
    // exit code — a `while` over empty input (docker ps itself failing,
    // e.g. a dead daemon, prints nothing and exits nonzero) still exits
    // 0 itself (zero iterations, nothing to report), so the failure was
    // silently read as "no containers found" and cleanup went on to
    // remove the folder without ever actually having checked. `$?` on
    // the command substitution is the real, load-bearing check.
    // No `2>/dev/null` (#250): when `docker ps` fails, its own stderr is
    // the only thing that says why, so it goes to the operator.
    '  ps_output=$(docker ps -a --filter "label=com.docker.compose.project.working_dir=$dir" ' +
    "--format '{{.ID}}|{{.Label \"com.docker.compose.project\"}}')",
    "  ps_rc=$?",
    '  if [ "$ps_rc" -ne 0 ]; then',
    '    if [ -e "$dir" ] || [ -L "$dir" ]; then',
    `      echo "FAILED to list containers for stale stack '$name': its folder was left in place."`,
    "    else",
    `      echo "FAILED to list containers for stale stack '$name'."`,
    "    fi",
    "    FAILED=1",
    "    return 1",
    "  fi",
    // Explicit `( ... )` subshell around the `while`, not a bare pipe
    // into it (#243 review, zsh): POSIX only requires each pipeline
    // stage to run in its OWN subshell, but zsh's default job control
    // runs a pipeline's LAST stage in the CURRENT shell whenever it
    // can — the remote login shell this script runs under, per
    // ssh/sshd, is often zsh. Without the explicit `(...)`, `exit 1`
    // below would exit the WHOLE script under zsh instead of just this
    // loop, well past what `stop_and_remove`'s own caller expects to
    // observe as a return value.
    "  if ! printf '%s\\n' \"$ps_output\" | ( while IFS='|' read -r id proj; do",
    '    case "$proj" in',
    "      ''|*[!A-Za-z0-9_.-]*) continue ;;",
    "    esac",
    '    case "$seen" in',
    '      *" $proj "*) continue ;;',
    "    esac",
    '    seen="$seen$proj "',
    // Never stop a project an active stack runs under (#250). The
    // project comes from a container label, and anyone with docker
    // access on the server can set labels: a stale container labelled
    // `project=traefik` would otherwise make `compose -p traefik down`
    // take down the live traefik. Checked after the dedupe so it is
    // reported once per project. A skip is deliberate, so it is
    // reported but never counted as a failure.
    protectArm,
    '    if ! docker compose -p "$proj" down --remove-orphans; then',
    "      echo \"FAILED to stop project '$proj' for stale stack '$name'\"",
    "      exit 1",
    "    fi",
    "  done ); then",
    // The stop failed: never remove the folder — the operator needs
    // its compose file to retry or investigate — and never print
    // "Removed"/"Stopped" (review round). The message names the folder
    // only when there still is one (#243 review): phase 2 calls this for
    // an orphaned container whose folder is already gone, so "its
    // folder was left in place" would be a lie there.
    '    if [ -e "$dir" ] || [ -L "$dir" ]; then',
    `      echo "FAILED to stop stale stack '$name': its folder was left in place."`,
    "    else",
    `      echo "FAILED to stop stale stack '$name'."`,
    "    fi",
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
    // "Data under VOLUMES_PATH kept", never "VOLUMES_PATH/<name>" (lead
    // review): several catalog stacks don't lay their data out under a
    // folder named after the stack itself (usememos keeps its data in
    // .../memos, woodpecker splits into woodpecker-server and
    // woodpecker-agent, librespeed has no data folder at all), so
    // naming a specific subfolder here would be wrong for part of the
    // catalog. stack-remove.ts's own next-steps message uses the same
    // wording for the same reason.
    `    echo "Removed stale stack '$name'. Data under '$VOLUMES_SHOWN' kept."`,
    "  else",
    `    echo "Stopped stale stack '$name' (its folder was already gone). Data under ` +
    `'$VOLUMES_SHOWN' kept."`,
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
    //
    // The `docker ps` call itself is captured into a variable and its
    // own `$?` checked (#243 review — same bug class as
    // stop_and_remove's exact-match scan above): piping straight into
    // `while` would lose a failure here too, silently treating "docker
    // ps itself failed" as "found nothing to stop" instead of reporting
    // and failing. `2>/dev/null` is dropped for the same reason — a
    // failure's own stderr belongs on the operator's screen, not
    // discarded.
    "broad_ps_output=$(docker ps -a --filter 'label=com.docker.compose.project.working_dir' " +
    "--format '{{.Label \"com.docker.compose.project.working_dir\"}}')",
    "broad_ps_rc=$?",
    'if [ "$broad_ps_rc" -ne 0 ]; then',
    '  echo "FAILED to list containers for the orphaned-container scan."',
    "  FAILED=1",
    "else",
    // Explicit `( rc=0; while ...; done; exit "$rc" )` subshell, never a
    // bare pipe into the `while` (#243 review, zsh — same reasoning as
    // stop_and_remove's own loop above: zsh runs a pipeline's LAST
    // stage in the CURRENT shell, and the remote login shell this
    // script runs under is often zsh). `rc` accumulates every failure
    // instead of `exit`-ing on the first one (#243 point 3: one stale
    // stack failing to stop must never stop the rest from being tried)
    // — the loop always runs to completion; only the subshell's FINAL
    // exit status, taken from `rc`, decides whether the outer `||
    // FAILED=1` fires.
    "  printf '%s\\n' \"$broad_ps_output\" | ( rc=0",
    "  while IFS= read -r wd; do",
    '    case "$wd" in',
    `      ${quotedStacksDir}/*)`,
    `        rel=\${wd#${quotedStacksDir}/}`,
    '        case "$rel" in */*) continue ;; esac',
    // Skip a name only when it's a REAL DIRECTORY under STACKS_DIR
    // (#243 review — regression fix): phase 1 already called
    // stop_and_remove for every real directory, success or failure, so
    // this broad, prefix-only scan would otherwise reach an
    // already-handled stack again and double-report it. `-d` alone,
    // never `-e`/`-L` (the branch's earlier mistake): phase 1 does NOT
    // call stop_and_remove for a BROKEN symlink or a plain file under
    // STACKS_DIR (it reports "not a directory" and moves on), so this
    // scan is the ONLY place that ever stops and removes an orphaned
    // container sitting behind one — origin/main does this, and
    // skipping on `-e`/`-L` here would silently stop this branch from
    // doing it. Only checked for a name that's otherwise safe (the
    // same charset stop_and_remove itself requires) — an unsafe name
    // like ".." must still fall through to stop_and_remove's own
    // report, never be silently skipped here ("$STACKS_DIR/.." is
    // always a real directory — it's the parent directory itself —
    // which would otherwise defeat the unsafe-name guard entirely).
    '    case "$rel" in',
    "      ''|*[!A-Za-z0-9_-]*) ;;",
    "      *)",
    '        if [ -d "$STACKS_DIR/$rel" ]; then continue; fi',
    "        ;;",
    "    esac",
    '    case " $rel " in',
    `${keepArm}      *) stop_and_remove "$rel" || rc=1 ;;`,
    "    esac",
    "    ;;",
    "  esac",
    "  done",
    '  exit "$rc"',
    "  ) || FAILED=1",
    "fi",
    "",
    '[ "$FAILED" = 0 ]',
  ]
  return lines.join("\n")
}
