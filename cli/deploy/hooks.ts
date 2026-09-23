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
// Passing `env` as a plain object (instead of Deno's `--env-file`, which
// mangles `$`) is the fix for the traefik hook's htpasswd workaround —
// see stacks/traefik/before.deploy.ts's old comment about
// BASIC_AUTH_BASE64.

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

  console.log(`Running ${kind}.deploy.ts for stack ${stackName}...`)
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", source],
    cwd: stagingDir,
    env: {
      ...ctx.rootEnv,
      ...ctx.serverEnv,
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
