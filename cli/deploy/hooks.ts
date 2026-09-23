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
// The deploying process's OWN real environment still wins on every
// name it already has (Option B from the issue) — a hook's own tool
// calls still resolve real binaries/caches through the process's real
// PATH/HOME/DENO_DIR/etc., never a `.env`-supplied value.
// DENIED_ENV_KEY_NAMES/PREFIXES is now a backstop that runs BEFORE the
// allowlist check: a stack whose own prefix happens to collide with a
// dangerous name (a stack literally named "ld" → prefix "LD_" → would
// otherwise allow "LD_PRELOAD") still gets it dropped.

import { UserError } from "../errors.ts"
import { isServerKey, stackKeyPrefix } from "../server-keys.ts"
import { trackChild } from "./process-registry.ts"

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
  /** One line per key dropped from `.env`/`.env.root`, naming the file it came from. */
  warnings: string[]
}

/**
 * Build the environment a hook subprocess runs with.
 *
 * Starts from the deploying process's own real environment (so a
 * hook's tool calls always resolve real binaries/caches — Option B).
 * Then, for each `.env.root`/server-`.env` key not already covered by
 * that real environment: drop it (with a warning naming the file) if
 * it's on the DENIED_ENV_KEY_NAMES/PREFIXES backstop, drop it (same
 * warning) if it isn't a plain-shell-named server key or `stackName`'s
 * own prefix, otherwise let it through. Finally the contract keys
 * (SSH_ADDRESS/SSH_USER/PATH_APPS/DEPLOY_AS) are set unconditionally.
 */
export function buildHookEnv(
  ctx: HookContext,
  stackName: string,
  processEnv: Record<string, string>,
): HookEnvResult {
  const fromFiles = { ...ctx.rootEnv, ...ctx.serverEnv }
  const resolved: Record<string, string> = { ...processEnv }
  const warnings: string[] = []

  for (const [key, value] of Object.entries(fromFiles)) {
    if (key in processEnv) continue // the process's own real value already wins — nothing to drop or warn about

    const source = key in ctx.serverEnv ? ctx.envPath : ctx.rootEnvPath
    if (isDeniedEnvKey(key)) {
      warnings.push(`Warning: dropping ${key} from ${source} — always denied.`)
      continue
    }
    if (!isAllowedFileEnvKey(key, stackName)) {
      warnings.push(
        `Warning: dropping ${key} from ${source} — not a server key or stack '${stackName}''s own prefix.`,
      )
      continue
    }
    resolved[key] = value
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
 */
export async function runHook(
  kind: "before" | "after",
  stackName: string,
  source: string | undefined,
  stagingDir: string,
  ctx: HookContext,
): Promise<void> {
  if (!source) return

  const { env, warnings } = buildHookEnv(ctx, stackName, Deno.env.toObject())
  for (const warning of warnings) {
    console.error(`${warning} (${kind}.deploy.ts, stack '${stackName}')`)
  }

  console.log(`Running ${kind}.deploy.ts for stack ${stackName}...`)
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", source],
    cwd: stagingDir,
    clearEnv: true,
    env,
    stdout: "inherit",
    stderr: "inherit",
  })
  const child = command.spawn()
  trackChild(child)
  const output = await child.output()
  if (!output.success) {
    throw new UserError(`${kind}.deploy.ts failed for stack '${stackName}' (${source})`)
  }
  console.log(`✓ ${kind}.deploy.ts for ${stackName}`)
}
