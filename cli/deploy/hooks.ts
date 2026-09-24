// Runs a stack's before/after deploy hook per the hook contract (#203
// point 3):
//
//   `stacks/<name>/before.deploy.ts` and `after.deploy.ts` are standalone
//   Deno scripts. Deploy runs them with `deno run -A` FROM THEIR SOURCE
//   LOCATION — the file in a local `stacks/` folder, or the URL of the
//   file inside the installed package — never from a staging copy, with
//   cwd = the local staging directory. The hook receives every KEY IT'S
//   ENTITLED TO from `.env.root` and the server `.env` (parsed by
//   rostok, no `$` expansion) — see the allowlist below — plus
//   SSH_ADDRESS, SSH_USER, PATH_APPS and DEPLOY_AS.
//
// `-A` means a hook is FULLY TRUSTED CODE: read/write/net/run/env, no
// sandbox. rostok runs it exactly the way it would run any other script
// checked into the catalog or a project's own `stacks/` — the same trust
// a `+meta.ts`, a `backup.ts` or `cli/` itself already gets. It is NOT
// sandboxed against the `.env`/`.env.root` content it's handed; treat a
// stack's hook with the same scrutiny as any other code you'd run
// locally with full permissions.
//
// Passing `env` as a plain object (instead of Deno's `--env-file`, which
// mangles `$`) is the fix for the traefik hook's htpasswd workaround —
// see stacks/traefik/before.deploy.ts's TRAEFIK_BASIC_AUTH_PASSWORD
// handling.
//
// (#217) One thing `.env`/`.env.root` content must NOT be allowed to
// do: steer which binary or script a hook's own tool invocations run.
// A shared `.env` with `PATH=/tmp/evil`, `BASH_ENV=configs/x.sh` or
// `SSH_ASKPASS=configs/x` (plus `SSH_ASKPASS_REQUIRE=force`) would
// silently redirect or hijack every subprocess a hook spawns.
//
// First fix: a deny-list of names ("PATH, HOME, LD_*, DENO_*, ...").
// It missed BASH_ENV/SSH_ASKPASS/GIT_SSH_COMMAND/RSYNC_RSH/PERL5OPT/
// PYTHONPATH — a list only ever covers the names someone thought of.
//
// Second fix (this one): flip a `.env`/`.env.root` key from
// deny-listed to ALLOW-LISTED. A key from those files reaches the hook
// only if it's a plain shell name AND it's a server key
// (`isServerKey()`, cli/server-keys.ts) or carries the hook's own
// stack's prefix (`stackKeyPrefix()`) — exactly the set #224 already
// requires every catalog hook/compose file to read from. Everything
// else from `.env`/`.env.root` is dropped, with a warning naming the
// file (never the value).
//
// Precedence between the deploying process's own environment and a
// `.env`/`.env.root` value depends on WHICH key it is (third pass,
// after review):
//   - Denied or not-allowed (dropped either way): the parent's own
//     value wins, if it has one — this is Option B's actual security
//     intent, so a name the shell already configures for some tool
//     can't be redirected by a value the hook isn't entitled to anyway.
//   - Allowed (a server key, or the hook's own stack's prefix): the
//     `.env`/`.env.root` value wins outright, even over a same-named
//     parent variable — a shell that happens to export `DOMAIN` or
//     `PROJECT` must not silently steer what a stack-owned key resolves
//     to; the deploy-time value is authoritative for those.
// DENIED_ENV_KEY_NAMES/PREFIXES is a backstop that runs BEFORE the
// allowlist check: a stack whose own prefix happens to collide with a
// dangerous name (a stack literally named "ld" → prefix "LD_" → would
// otherwise allow "LD_PRELOAD") still gets it dropped.
//
// Also (per that same review): a hook run also SPAWNS under `setsid`
// when this Deno build and OS support process-group signalling, so
// SIGINT/SIGTERM reaches the hook's own children too — see
// process-registry.ts and docs/contributing/adding-services.md.

import { UserError } from "../errors.ts"
import { isServerKey, stackKeyPrefix } from "../server-keys.ts"
import { setsidAvailable, supportsProcessGroupKill, trackChild } from "./process-registry.ts"

export interface HookContext {
  rootEnv: Record<string, string>
  serverEnv: Record<string, string>
  /** Path to the server `.env` that produced `serverEnv` — named in a dropped-key warning. */
  envPath: string
  /** Path to `.env.root` that produced `rootEnv` — named in a dropped-key warning. */
  rootEnvPath: string
  sshAddress: string
  sshUser: string
  pathApps: string
  deployAs: string
}

/**
 * Names/prefixes always dropped from `.env`/`.env.root` before the
 * allowlist check even runs — a backstop for the case where a stack's
 * own prefix would otherwise have allowed one of these through (see
 * the module comment). Each controls what a hook's own subprocess runs
 * (SSH_ASKPASS*, BASH_ENV, ENV, GIT_SSH*, GIT_ASKPASS,
 * GIT_PROXY_COMMAND, GIT_CONFIG_*, GIT_EXEC_PATH, RSYNC_RSH,
 * RSYNC_CONNECT_PROG, PERL5*, PYTHON*, NODE_OPTIONS, SHELLOPTS,
 * BASHOPTS, PS4, PROMPT_COMMAND, IFS, BASH_FUNC_*) or where it loads
 * code/binaries/config from (LD_*, DYLD_*, DENO_*, NPM_CONFIG_*,
 * DOCKER_HOST, DOCKER_CONFIG, XDG_CONFIG_HOME) — plus
 * PATH/HOME/USER/SHELL/SSH_AUTH_SOCK/TMPDIR/NODE_* from the original
 * deny-list, kept as a second layer even though the deploy process
 * always has those set.
 */
const DENIED_ENV_KEY_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "SSH_AUTH_SOCK",
  "TMPDIR",
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
  "BASH_ENV",
  "ENV",
  // Redirects where a hook's own `jsr:` imports are fetched from.
  "JSR_URL",
  "GIT_ASKPASS",
  "GIT_PROXY_COMMAND",
  "GIT_EXEC_PATH",
  "RSYNC_RSH",
  "RSYNC_CONNECT_PROG",
  "NODE_OPTIONS",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "IFS",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "XDG_CONFIG_HOME",
])
const DENIED_ENV_KEY_PREFIXES = [
  "LD_",
  "DYLD_",
  "DENO_",
  "NPM_CONFIG_",
  "NODE_",
  "PYTHON",
  "PERL5",
  "GIT_SSH",
  "GIT_CONFIG_",
  "BASH_FUNC_",
]

/** True for a name/prefix always dropped from `.env`/`.env.root`, checked before the allowlist. Exported for tests. */
export function isDeniedEnvKey(key: string): boolean {
  return DENIED_ENV_KEY_NAMES.has(key) || DENIED_ENV_KEY_PREFIXES.some((p) => key.startsWith(p))
}

/** A plain shell identifier — nothing a shell, `exec.getenv`, etc. would read specially in the name itself. */
const PLAIN_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * True when `key` may reach a hook from `.env`/`.env.root`: a plain
 * shell name that's either a server key or carries `stackName`'s own
 * prefix. #224 already requires every catalog compose file/hook to
 * read only names in this set, so nothing legitimate is cut off.
 */
function isAllowedFileEnvKey(key: string, stackName: string): boolean {
  if (!PLAIN_ENV_KEY_PATTERN.test(key)) return false
  return isServerKey(key) || key.startsWith(stackKeyPrefix(stackName))
}

export interface HookEnvResult {
  env: Record<string, string>
  /** Human-readable lines describing what was dropped, and from where — never a value. */
  warnings: string[]
}

/** Strip ASCII control characters (including DEL) from `s` before it goes into a log line or error message — a key name is untrusted input too. */
function sanitizeForLog(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, "")
}

/**
 * Build the environment a hook subprocess runs with.
 *
 * Starts from the deploying process's own real environment (a hook's
 * tool calls always resolve real binaries/caches this way). Then, for
 * each `.env.root`/server-`.env` key:
 *
 * - Denied (DENIED_ENV_KEY_NAMES/PREFIXES backstop) or not allowed
 *   (not a plain-shell-named server key or `stackName`'s own prefix):
 *   dropped. The PARENT PROCESS's own value for that name, if any,
 *   still wins here — that's Option B's actual security intent: a name
 *   the shell already configures (a tool's own env var, PATH, ...)
 *   can never be redirected by a `.env`/`.env.root` value the hook
 *   isn't entitled to anyway.
 * - Allowed (a server key, or carries `stackName`'s own prefix): the
 *   `.env`/`.env.root` VALUE WINS, even over a same-named parent
 *   variable — a shell that happens to export `DOMAIN` or `PROJECT`
 *   must not silently steer what stack-owned keys a hook sees; the
 *   deploy-time value is authoritative there.
 *
 * The contract keys (SSH_ADDRESS/SSH_USER/PATH_APPS/DEPLOY_AS) are set
 * last, unconditionally, from rostok's own validated values.
 */
export function buildHookEnv(
  ctx: HookContext,
  stackName: string,
  processEnv: Record<string, string>,
): HookEnvResult {
  const fromFiles = { ...ctx.rootEnv, ...ctx.serverEnv }
  const resolved: Record<string, string> = { ...processEnv }
  const deniedWarnings: string[] = []
  const droppedByFile = new Map<string, string[]>() // file path -> dropped key names

  for (const [key, value] of Object.entries(fromFiles)) {
    const source = key in ctx.serverEnv ? ctx.envPath : ctx.rootEnvPath
    if (isDeniedEnvKey(key)) {
      // The parent's own value (if any) already wins via the initial
      // spread above — only warn when this .env value would otherwise
      // have been the only source (nothing to warn about if the real
      // environment already had it, since the file's attempt changed
      // nothing).
      if (!(key in processEnv)) {
        deniedWarnings.push(
          `Warning: dropping ${sanitizeForLog(key)} from ${source} — always denied.`,
        )
      }
      continue
    }
    if (!isAllowedFileEnvKey(key, stackName)) {
      if (!(key in processEnv)) {
        const list = droppedByFile.get(source) ?? []
        list.push(sanitizeForLog(key))
        droppedByFile.set(source, list)
      }
      continue
    }
    // Allowed: the .env/.env.root value wins outright.
    resolved[key] = value
  }

  const warnings: string[] = [...deniedWarnings]
  for (const [source, keys] of droppedByFile) {
    warnings.push(
      `Warning: dropped ${keys.length} key(s) from ${source} not meant for stack ` +
        `'${sanitizeForLog(stackName)}': ${keys.join(", ")}`,
    )
  }

  resolved.SSH_ADDRESS = ctx.sshAddress
  resolved.SSH_USER = ctx.sshUser
  resolved.PATH_APPS = ctx.pathApps
  resolved.DEPLOY_AS = ctx.deployAs

  return { env: resolved, warnings }
}

/**
 * Run one hook script if `source` is defined (a stack without that hook
 * is a no-op). `source` is a file:// or https:// URL — `deno run -A`
 * accepts both directly.
 *
 * `stackName` is the CATALOG stack name — the only thing `buildHookEnv`
 * uses to compute the allowlist prefix (`stackKeyPrefix`). `label` is
 * what shows up in logs/errors, and defaults to `stackName`; a caller
 * running a SERVER-SPECIFIC override of a stack's hook (run-deploy.ts)
 * passes a distinguishing label like "traefik (server override)"
 * while still passing the real stack name "traefik" — passing that
 * label as `stackName` instead would compute the prefix for a
 * nonexistent stack called "traefik (server override)" and silently
 * drop every one of the real stack's own keys.
 *
 * Spawns the hook under `setsid` when available (and this Deno build's
 * `Deno.kill` accepts a negative pid — see process-registry.ts) so the
 * whole process TREE it starts can be signalled together on
 * SIGINT/SIGTERM, not just this one process — see
 * docs/contributing/adding-services.md for what a hook itself must do
 * when that isn't available.
 */
export async function runHook(
  kind: "before" | "after",
  stackName: string,
  source: string | undefined,
  stagingDir: string,
  ctx: HookContext,
  label: string = stackName,
): Promise<void> {
  if (!source) return

  const { env, warnings } = buildHookEnv(ctx, stackName, Deno.env.toObject())
  for (const warning of warnings) {
    console.error(`${warning} (${kind}.deploy.ts, stack '${label}')`)
  }

  console.log(`Running ${kind}.deploy.ts for stack ${label}...`)
  const useGroup = supportsProcessGroupKill() && await setsidAvailable()
  const command = useGroup
    ? new Deno.Command("setsid", {
      args: [Deno.execPath(), "run", "-A", source],
      cwd: stagingDir,
      clearEnv: true,
      env,
      stdout: "inherit",
      stderr: "inherit",
    })
    : new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", source],
      cwd: stagingDir,
      clearEnv: true,
      env,
      stdout: "inherit",
      stderr: "inherit",
    })
  const child = command.spawn()
  trackChild(child, useGroup)
  const output = await child.output()
  if (!output.success) {
    throw new UserError(`${kind}.deploy.ts failed for stack '${label}' (${source})`)
  }
  console.log(`✓ ${kind}.deploy.ts for ${label}`)
}
