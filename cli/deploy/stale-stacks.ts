// Removes stacks that `config.json` no longer lists, before any file
// sync touches the remote (#233 point 4).
//
// The old cleanup ran AFTER rsync and only ever did `rm -rf` on the
// stack's folder — the containers kept running, unmanaged, and nothing
// ever stopped them. Two problems with running it after rsync, now that
// a full deploy syncs `PATH_APPS` with `--delete` (run-deploy.ts): by the
// time this script would run, rsync could already have deleted the
// folder itself, and `docker compose down` needs that folder (it reads
// `compose.yml` from it) to know what to stop — so this MUST run first.
//
// `docker compose down --remove-orphans` runs in the stack's own folder
// before it's removed. `VOLUMES_PATH/<stack>` is never referenced by any
// command here — only named in the printed message — so app data always
// survives, even though the stack can no longer be redeployed until it's
// added back to config.json.
//
// A folder that's already gone (a hand-run `rm -rf`, or an older rostok
// version's rm-only cleanup) can still leave containers running: those
// are found by the `com.docker.compose.project.working_dir` label
// (compose sets it to the folder it was run from) instead, and removed
// directly with `docker rm -f` — never `docker compose down`, since
// there's no compose file left to run that with.

import { shQuote } from "./exec.ts"

/**
 * Build the remote shell script that stops and removes every stack
 * folder under `${pathApps}/stacks/` that `activeStackNames` (the FULL
 * config.json list, never a single-stack deploy's filtered one) doesn't
 * name, plus any container left behind by an already-missing folder.
 *
 * Every stack/container value that reaches the script is single-quoted
 * (`shQuote`) — the same double-quote gap `run-deploy.ts`'s other
 * generated scripts already guard against (`$(...)`/backticks survive a
 * double-quoted case pattern). `pathApps` itself is validated
 * (`validateRemotePath`, cli/server-keys.ts) by the caller before this
 * is ever built.
 */
export function generateStaleStackCleanupScript(
  activeStackNames: string[],
  pathApps: string,
  volumesPath: string,
): string {
  const stacksDir = `${pathApps}/stacks`
  const quotedStacksDir = shQuote(stacksDir)
  // " name1 |name2 | name3 " style case pattern, spaces included, so
  // "traefik" doesn't also match a folder named "traefik-old" — the same
  // technique run-deploy.ts's other stale-stack pattern already uses.
  // An empty list (config.json names no stacks at all) has no "keep this
  // one" arm to write at all — see keepArm below — so every folder
  // correctly counts as stale rather than needing a sentinel pattern
  // that "can never match" (a NUL byte would do that, but Deno's process
  // spawn refuses argv containing one).
  const activePattern = activeStackNames.map((s) => shQuote(` ${s} `)).join("|")
  const keepArm = activePattern.length > 0 ? `      ${activePattern}) ;;\n` : ""

  const lines = [
    "(",
    `  cd ${quotedStacksDir} 2>/dev/null || exit 0`,
    "  for dir in */; do",
    '    dir_name="${dir%/}"',
    '    case " ${dir_name} " in',
    `${keepArm}      *)`,
    "        echo \"Stopping stale stack '${dir_name}'...\"",
    '        ( cd "${dir_name}" && docker compose down --remove-orphans ) 2>&1 || true',
    '        rm -rf "${dir}"',
    `        echo "Removed '\${dir_name}' from ${stacksDir}. Data kept at '${volumesPath}/\${dir_name}'."`,
    "        ;;",
    "    esac",
    "  done",
    ")",
    "docker ps -a --filter 'label=com.docker.compose.project.working_dir' " +
    "--format '{{.ID}}|{{.Label \"com.docker.compose.project.working_dir\"}}' 2>/dev/null | " +
    "while IFS='|' read -r id wd; do",
    '  case "${wd}" in',
    `    ${quotedStacksDir}/*)`,
    `      stack_name=\${wd#${quotedStacksDir}/}`,
    '      stack_name="${stack_name%%/*}"',
    '      case " ${stack_name} " in',
    `${activePattern.length > 0 ? `        ${activePattern}) ;;\n` : ""}        *)`,
    '          echo "Removing orphaned container ${id} (stack ${stack_name} not in config.json)..."',
    '          docker rm -f "${id}" >/dev/null 2>&1 || true',
    "          ;;",
    "      esac",
    "      ;;",
    "  esac",
    "done",
  ]
  return lines.join("\n")
}
