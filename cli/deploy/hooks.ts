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
//   SSH_ADDRESS, SSH_HOST, SSH_PORT, SSH_USER, PATH_APPS and DEPLOY_AS
//   (SSH_HOST/SSH_PORT: #229, see the module comment further down).
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
// (#234) A key that isn't allowed for the CURRENT stack but carries
// another stack's own prefix, and that other stack is also installed on
// this server, is dropped silently — no warning. This is the expected,
// correct case on any server with more than one stack (traefik's hook
// dropping librespeed's LIBRESPEED_* keys, say): the allow-list itself
// doesn't change (buildHookEnv still only ever hands a hook ITS OWN
// keys, proven by a test asserting the resolved hook env is unchanged),
// only the warning does. A key matching NO installed stack — a typo, or
// a leftover from a stack `stack remove` already dropped from
// config.json — still gets one warning line naming it.
//
// DENIED_ENV_KEY_NAMES/PREFIXES is a backstop that runs BEFORE the
// allowlist check: a stack whose own prefix happens to collide with a
// dangerous name (a stack literally named "ld" → prefix "LD_" → would
// otherwise allow "LD_PRELOAD") still gets it dropped.
//
// Also (per that same review): a hook run also SPAWNS under `setsid`
// when this Deno build and OS support process-group signalling, so
// SIGINT/SIGTERM reaches the hook's own children too — see
// process-registry.ts and docs/contributing/adding-services.md.
//
// (#229) SSH_HOST and SSH_PORT contract keys. Several hooks (syncthing,
// stalwart, caldiy, open-webui, plus traefik/gatus before this round)
// spawn `ssh` themselves to reach the deploy target — for a health
// check, a restart, a one-off remote command. Every one of them used to
// hand the raw SSH_ADDRESS string straight to `ssh`/`rsync`, which reads
// "host:port" as a literal (unresolvable) hostname the moment
// SSH_ADDRESS carries a port — a deploy that otherwise succeeds then
// fails inside that one hook. `buildHookEnv` now parses SSH_ADDRESS once
// with `parseSshAddress` (the same parser `cli/deploy/exec.ts` uses for
// rostok's own ssh/rsync calls) and sets:
//
//   - SSH_HOST — the bare host/ssh_config-alias, never the port.
//   - SSH_PORT — set ONLY when SSH_ADDRESS carries an explicit port
//     (never a default). A hook adds `-p <SSH_PORT>` to its ssh argv
//     only when SSH_PORT is non-empty, and validates it as digits
//     1-65535 before use (defense in depth: SSH_ADDRESS was already
//     validated once by parseSshAddress here, but a hook's own argv
//     builder re-checks anyway, since it's the last place before the
//     value reaches `ssh`). This mirrors `cli/deploy/exec.ts`'s own
//     `sshArgs()`, which deploy's core ssh/rsync calls already use — see
//     the Decision below for why.
//
// SSH_USER is unchanged: it was already a contract key sourced from
// resolveDeployEnv's own required SSH_USER (server create always writes
// one, whether typed separately or extracted from a `user@host`
// SSH_ADDRESS at server-create time) — not re-derived from SSH_ADDRESS
// here, so it's unaffected by whether THIS SSH_ADDRESS happens to embed
// a user. `cli/deploy/env.ts`'s `resolveDeployEnv` now also checks that
// SSH_USER agrees with the user part of SSH_ADDRESS when SSH_ADDRESS has
// one — a hook and deploy's own ssh calls must log in as the same user.
//
// Decision: SSH_PORT is set only for an explicit port, matching
// `sshArgs()`'s own rule for deploy's core ssh/rsync calls. An earlier
// version of this defaulted SSH_PORT to "22" and had every hook pass
// `-p 22` unconditionally, which would override a bare ssh_config
// alias's own non-default `Port` directive — the exact regression
// "an ssh_config alias target must keep working" warns against. Omitting
// `-p` when SSH_PORT is unset lets ssh consult `~/.ssh/config` for that
// alias, the same as before #229 and the same as every non-hook ssh call
// deploy makes.

import { UserError } from "../errors.ts"
import { isServerKey, parseSshAddress, stackKeyPrefix } from "../server-keys.ts"
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
  /**
   * Every catalog stack name deployed on this server (config.json's full
   * list, not filtered down to a single-stack deploy) — #234. A key
   * dropped from `.env`/`.env.root` because it isn't THIS stack's own
   * (`isAllowedFileEnvKey` below) is still routine, not a warning, when
   * it carries another INSTALLED stack's prefix: e.g. librespeed's
   * `LIBRESPEED_*` keys reaching the traefik hook. Only a key matching no
   * installed stack (and no server key) still gets a warning.
   */
  installedStackNames: string[]
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
 * Strips one matching quote layer (`'...'` or `"..."` around the whole
 * value), and nothing else: no backslash escapes, no `#` comment
 * stripping. docker compose's `env_file` and Deno's `--env-file` do more
 * than this: both turn `\n` inside double quotes into a real newline and
 * drop a trailing ` # comment` from an unquoted value. For those forms a
 * hook can see a different value than its container, so a key a hook
 * reads should not rely on escapes or trailing comments. The common case,
 * a quoted value with spaces, matches. `@spy4x/server/env-age64`'s
 * `parseEnvFile` keeps a value's quotes for the file round trip (#226),
 * so the stripping happens here, once, on the way into the hook's
 * environment.
 */
function stripOneQuoteLayer(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1)
    }
  }
  return value
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
 *   deploy-time value is authoritative there. Its quotes are stripped
 *   once (`stripOneQuoteLayer`) before it reaches the hook's env — a
 *   `.env` value keeps its quotes on disk (#226), but docker compose's
 *   `env_file` and Deno's `--env-file` both strip them when they
 *   actually load the file, so a hook (which reads the same values a
 *   container does) needs the same treatment to see what its container
 *   sees.
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
      // #234: a key carrying another INSTALLED stack's own prefix is
      // routine — every stack's keys sit in the same server .env, and a
      // hook only ever gets its own. Only a key matching no installed
      // stack (and no server key, already handled by
      // isAllowedFileEnvKey/isServerKey above) still warns.
      const ownedByAnotherInstalledStack = ctx.installedStackNames.some(
        (otherStack) => otherStack !== stackName && key.startsWith(stackKeyPrefix(otherStack)),
      )
      if (!(key in processEnv) && !ownedByAnotherInstalledStack) {
        const list = droppedByFile.get(source) ?? []
        list.push(sanitizeForLog(key))
        droppedByFile.set(source, list)
      }
      continue
    }
    // Allowed: the .env/.env.root value wins outright — quotes stripped
    // once here, so the hook sees exactly what its own container would
    // (docker compose's env_file/Deno's --env-file both strip them too).
    resolved[key] = stripOneQuoteLayer(value)
  }

  const warnings: string[] = [...deniedWarnings]
  for (const [source, keys] of droppedByFile) {
    warnings.push(
      `Warning: dropped ${keys.length} key(s) from ${source} not meant for stack ` +
        `'${sanitizeForLog(stackName)}': ${keys.join(", ")}`,
    )
  }

  const target = parseSshAddress(ctx.sshAddress)
  resolved.SSH_ADDRESS = ctx.sshAddress
  resolved.SSH_HOST = target.host
  // Set only for an explicit port — never a default. Deleted rather than
  // left unset so an ambient SSH_PORT in the deploying process's own
  // shell can't leak through as if it were authoritative (see the
  // module comment's Decision above).
  if (target.port !== undefined) {
    resolved.SSH_PORT = String(target.port)
  } else {
    delete resolved.SSH_PORT
  }
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
