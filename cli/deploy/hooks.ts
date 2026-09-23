// Runs a stack's before/after deploy hook per the hook contract (#203
// point 3):
//
//   `stacks/<name>/before.deploy.ts` and `after.deploy.ts` are standalone
//   Deno scripts. Deploy runs them with `deno run -A` FROM THEIR SOURCE
//   LOCATION — the file in a local `stacks/` folder, or the URL of the
//   file inside the installed package — never from a staging copy, with
//   cwd = the local staging directory. The hook receives every key of
//   `.env.root` and the server `.env` (parsed by rostok, no `$`
//   expansion), plus SSH_ADDRESS, SSH_USER, PATH_APPS and DEPLOY_AS.
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
// silently redirect or hijack every subprocess a hook spawns —
// starting `bash` runs whatever BASH_ENV names on every invocation;
// SSH_ASKPASS_REQUIRE=force runs SSH_ASKPASS even without a TTY.
//
// A deny-list of names ("PATH, HOME, LD_*, DENO_*, ...") was tried
// first and missed exactly this class — nobody had thought of
// BASH_ENV/SSH_ASKPASS/GIT_SSH_COMMAND/RSYNC_RSH/PERL5OPT/PYTHONPATH
// yet. The fix (#217, option B from the issue): the deploying
// process's OWN environment wins on every name it already has —
// `{ ...fromEnvFiles, ...Deno.env.toObject(), ...contractKeys }`. A
// hook's own subprocess resolution then can't be redirected by any
// name the deploy process's real environment already controls, known
// or not. DENIED_ENV_KEY_NAMES below is only a backstop for names that
// are USUALLY UNSET in the parent (so the "process wins" rule alone
// wouldn't drop them) but still control what a hook's subprocess runs
// or where it loads code from.

import { UserError } from "../errors.ts"

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
 * Names usually unset in the deploy process's own environment, so
 * `{ ...fromEnvFiles, ...Deno.env.toObject() }` alone wouldn't drop
 * them if `.env`/`.env.root` set one. Each controls what a hook's own
 * subprocess runs (SSH_ASKPASS*, BASH_ENV, ENV, GIT_SSH*, RSYNC_RSH,
 * PERL5*, PYTHONPATH*, NODE_OPTIONS) or where it loads code/binaries
 * from (LD_*, DYLD_*, DENO_*, NPM_CONFIG_*) — plus PATH/HOME/USER/SHELL/
 * SSH_AUTH_SOCK/TMPDIR/NODE_* from the original deny-list, kept as a
 * second layer even though the deploy process always has those set.
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
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "RSYNC_RSH",
  "PERL5OPT",
  "PERL5LIB",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "NODE_OPTIONS",
])
const DENIED_ENV_KEY_PREFIXES = ["LD_", "DYLD_", "DENO_", "NPM_CONFIG_", "NODE_"]

function isDeniedEnvKey(key: string): boolean {
  return DENIED_ENV_KEY_NAMES.has(key) || DENIED_ENV_KEY_PREFIXES.some((p) => key.startsWith(p))
}

export interface HookEnvResult {
  env: Record<string, string>
  /** One line per key the process's own environment kept, naming the file it would have come from. */
  warnings: string[]
}

/**
 * Build the environment a hook subprocess runs with: `.env.root` and the
 * server `.env` merged (server wins), overlaid by the deploy process's
 * own real environment (so any name it already controls wins outright —
 * #217 option B), then the contract keys the hook is promised
 * (SSH_ADDRESS/SSH_USER/PATH_APPS/DEPLOY_AS), then a final pass that
 * strips DENIED_ENV_KEY_NAMES/PREFIXES still holding a `.env`/`.env.root`
 * value (i.e. the process itself never set them) — see the module
 * comment for why that backstop exists.
 */
export function buildHookEnv(ctx: HookContext, processEnv: Record<string, string>): HookEnvResult {
  const fromFiles = { ...ctx.rootEnv, ...ctx.serverEnv }
  const resolved: Record<string, string> = { ...fromFiles, ...processEnv }

  const warnings: string[] = []
  for (const key of Object.keys(fromFiles)) {
    if (!isDeniedEnvKey(key)) continue
    if (key in processEnv) continue // the process's own value already won above — nothing to drop
    delete resolved[key]
    const source = key in ctx.serverEnv ? ctx.envPath : ctx.rootEnvPath
    warnings.push(`Warning: ignoring ${key} from ${source} — kept the deploy process's own value.`)
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

  const { env, warnings } = buildHookEnv(ctx, Deno.env.toObject())
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
  const output = await command.output()
  if (!output.success) {
    throw new UserError(`${kind}.deploy.ts failed for stack '${stackName}' (${source})`)
  }
  console.log(`✓ ${kind}.deploy.ts for ${stackName}`)
}
