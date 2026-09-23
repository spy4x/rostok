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
// One thing `.env`/`.env.root` content must NOT be allowed to do:
// override the process-level variables a hook's own tool invocations
// rely on to find the right binaries and caches. A shared `.env` with
// `PATH=/tmp/evil` or `NPM_CONFIG_REGISTRY=https://attacker` would
// silently redirect every subprocess a hook spawns — see
// DENIED_ENV_KEY_PATTERNS below. These keys always keep the deploy
// process's own value; a hook that genuinely needs one reads it from
// `Deno.env` directly (which still sees the real parent value, since it
// was never overridden), not from the merged `.env` content.

import { UserError } from "../errors.ts"

export interface HookContext {
  rootEnv: Record<string, string>
  serverEnv: Record<string, string>
  sshAddress: string
  sshUser: string
  pathApps: string
  deployAs: string
}

/**
 * Keys from `.env`/`.env.root` never override the hook subprocess's own
 * environment — PATH/HOME/USER/SHELL control which binaries and home
 * directory a hook's tool calls resolve to; LD_ and DYLD_ prefixed keys
 * control dynamic linking; DENO_, NPM_CONFIG_ and NODE_ prefixed keys
 * control module/package resolution (a poisoned NPM_CONFIG_REGISTRY
 * could swap in a malicious package for any `npm:` import a hook makes);
 * SSH_AUTH_SOCK controls which ssh agent a hook's own `ssh` calls use;
 * TMPDIR controls where its temp files land. All of these stay the
 * parent (deploy) process's real values, inherited normally, rather
 * than being overridable by whatever ends up in a shared `.env`.
 */
const DENIED_ENV_KEY_PATTERNS: readonly RegExp[] = [
  /^PATH$/,
  /^HOME$/,
  /^USER$/,
  /^SHELL$/,
  /^LD_/,
  /^DYLD_/,
  /^DENO_/,
  /^NPM_CONFIG_/,
  /^NODE_/,
  /^SSH_AUTH_SOCK$/,
  /^TMPDIR$/,
]

function isDeniedEnvKey(key: string): boolean {
  return DENIED_ENV_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

/** Split `.env`/`.env.root` content into what a hook may see vs. what it may not (see DENIED_ENV_KEY_PATTERNS). */
function partitionHookEnv(
  merged: Record<string, string>,
): { allowed: Record<string, string>; denied: string[] } {
  const allowed: Record<string, string> = {}
  const denied: string[] = []
  for (const [key, value] of Object.entries(merged)) {
    if (isDeniedEnvKey(key)) {
      denied.push(key)
      continue
    }
    allowed[key] = value
  }
  return { allowed, denied }
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

  const { allowed, denied } = partitionHookEnv({ ...ctx.rootEnv, ...ctx.serverEnv })
  if (denied.length > 0) {
    console.error(
      `Warning: ignoring ${denied.join(", ")} from .env/.env.root for ${kind}.deploy.ts ` +
        `(stack '${stackName}') — these keep the deploy process's own values.`,
    )
  }

  console.log(`Running ${kind}.deploy.ts for stack ${stackName}...`)
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", source],
    cwd: stagingDir,
    env: {
      ...allowed,
      SSH_ADDRESS: ctx.sshAddress,
      SSH_USER: ctx.sshUser,
      PATH_APPS: ctx.pathApps,
      DEPLOY_AS: ctx.deployAs,
    },
    stdout: "inherit",
    stderr: "inherit",
  })
  const output = await command.output()
  if (!output.success) {
    throw new UserError(`${kind}.deploy.ts failed for stack '${stackName}' (${source})`)
  }
  console.log(`✓ ${kind}.deploy.ts for ${stackName}`)
}
