// after.deploy.ts — Sync OpenWebUI provider config + model whitelist from
// .env into the SQLite `config` table. Ensures the 3rd provider slot
// (MiniMax) stays registered after Watchtower auto-updates, schema
// migrations, or fresh volumes that drop the DB-backed provider list.
//
// Why this exists: OpenWebUI reads provider config from the SQLite
// `config` table via `get_openai_runtime_config()` (openai.py:276-283),
// NOT from container env vars. If the DB has 2 providers but .env
// declares 3, chat against the 3rd provider fails with the upstream's
// `insufficient balance (1008)` even though the key in .env is valid.
// Root cause: a Watchtower-pulled `:latest` upgrade or manual UI edit
// wrote a 2-entry config to the DB. This hook re-syncs after every
// deploy so the env-var declared provider set wins.
//
// Environment (auto-loaded by deploy script):
//   SSH_HOST, SSH_PORT, SSH_USER, PATH_APPS    from deploy context
//   OPEN_WEBUI_OPENAI_API_KEYS, OPEN_WEBUI_OPENAI_API_BASE_URLS
//                            from .env via --env-file=.env
//   (OPENAI_API_CONFIGS is hardcoded directly in compose.yml, not read
//   from .env — see the comment near its declaration below)
//
// SSH_HOST/SSH_PORT/SSH_USER are contract keys parsed once from
// SSH_ADDRESS by cli/deploy/hooks.ts's buildHookEnv (#229) — see its
// module comment. Building ssh's argv from these instead of the raw
// SSH_ADDRESS string is what lets a non-default port reach ssh as
// `-p <port>` instead of being read as part of an unresolvable
// "host:port" hostname.
//
// On failure: exit non-zero so deploy fails loudly. Provider sync is
// not optional — without it, the service is functionally broken.

import { error, log, runCommand, success } from "../../scripts/+lib.ts"

/**
 * The ssh option argv every remote call here gets: `-p <port>`, `-o
 * ConnectTimeout=10`, `-o BatchMode=yes`. Exported for tests — no I/O.
 * See cli/deploy/hooks.ts's module comment for the SSH_PORT default-22
 * decision (#229).
 */
export function buildSshOptionArgs(port: string): string[] {
  return ["-p", port, "-o", "ConnectTimeout=10", "-o", "BatchMode=yes"]
}

/** `[user@]host` — no brackets: ssh gets host and -p <port> as separate argv slots. */
export function targetHost(host: string, user: string | undefined): string {
  return user ? `${user}@${host}` : host
}

if (import.meta.main) {
  const SSH_HOST = Deno.env.get("SSH_HOST")
  const SSH_PORT = Deno.env.get("SSH_PORT")
  const SSH_USER = Deno.env.get("SSH_USER") || undefined
  const PATH_APPS = Deno.env.get("PATH_APPS")
  // Container-side names (OPENAI_API_KEYS/OPENAI_API_BASE_URLS, exported
  // below into the container's own shell) are unaffected by the host .env
  // prefix — only the host-side read changes.
  const OPENAI_API_KEYS = Deno.env.get("OPEN_WEBUI_OPENAI_API_KEYS")
  const OPENAI_API_BASE_URLS = Deno.env.get("OPEN_WEBUI_OPENAI_API_BASE_URLS")

  if (!SSH_HOST || !SSH_PORT || !PATH_APPS) {
    error("after.deploy.ts: SSH_HOST, SSH_PORT and PATH_APPS must be set")
    Deno.exit(1)
  }

  const SSH_TARGET = targetHost(SSH_HOST, SSH_USER)
  const SSH_OPTION_ARGS = buildSshOptionArgs(SSH_PORT)
  if (!OPENAI_API_KEYS || !OPENAI_API_BASE_URLS) {
    error(
      "after.deploy.ts: OPEN_WEBUI_OPENAI_API_KEYS and OPEN_WEBUI_OPENAI_API_BASE_URLS must be set in .env",
    )
    Deno.exit(1)
  }

  const SCRIPT_NAME = "init-models.py"
  // After rsync, the script lives on the remote under PATH_APPS/stacks/open-webui/.
  // Use the absolute path on the remote so `docker cp` finds it (the remote
  // user's cwd is $HOME, not the deploy target root).
  const REMOTE_SCRIPT_SRC = `${PATH_APPS}/stacks/open-webui/${SCRIPT_NAME}`
  const REMOTE_SCRIPT_TMP = `/tmp/${SCRIPT_NAME}`
  const CONTAINER = "hl-open-webui"

  log(`Copying ${REMOTE_SCRIPT_SRC} → ${CONTAINER}:${REMOTE_SCRIPT_TMP}...`)
  const cpResult = await runCommand([
    "ssh",
    ...SSH_OPTION_ARGS,
    "--",
    SSH_TARGET,
    `docker cp ${REMOTE_SCRIPT_SRC} ${CONTAINER}:${REMOTE_SCRIPT_TMP}`,
  ])
  if (!cpResult.success) {
    error(`docker cp failed: ${cpResult.error || cpResult.output}`)
    Deno.exit(1)
  }
  success("✓ script copied")

  // Run the script inside the container with the deploy-time env vars, so the
  // freshly-deployed .env values win over whatever stale values OWUI might
  // still hold in its own env block.
  //
  // The keys are fed over stdin, NOT via `docker exec -e KEY=value`. An -e
  // argument is part of the command line, so the API keys would be visible in
  // `ps` on the remote host for the lifetime of the exec, and in the argv of
  // the local ssh process. `read` in the container shell keeps them off both.
  //
  // OPENAI_API_CONFIGS is deliberately not passed: it is hardcoded in
  // compose.yml (servers/home/.env keeps it empty as a placeholder), so the
  // script inherits the compose value from the container's own env.
  log(`Running ${SCRIPT_NAME} inside ${CONTAINER}...`)

  // One line per secret, in the order the reader below consumes them. Neither
  // value may contain a newline; guard rather than silently truncate.
  for (const [name, value] of Object.entries({ OPENAI_API_KEYS, OPENAI_API_BASE_URLS })) {
    if (value.includes("\n")) {
      error(`${name} contains a newline, which the stdin handoff cannot represent`)
      Deno.exit(1)
    }
  }
  const stdinPayload = `${OPENAI_API_KEYS}\n${OPENAI_API_BASE_URLS}\n`

  // IFS= and -r so whitespace and backslashes survive verbatim.
  const remoteScript = `docker exec -i ${CONTAINER} sh -c '` +
    `IFS= read -r k; IFS= read -r u; ` +
    `export OPENAI_API_KEYS="$k" OPENAI_API_BASE_URLS="$u"; ` +
    `exec python3 ${REMOTE_SCRIPT_TMP}'`

  const execProc = new Deno.Command("ssh", {
    args: [...SSH_OPTION_ARGS, "--", SSH_TARGET, remoteScript],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn()
  const writer = execProc.stdin.getWriter()
  await writer.write(new TextEncoder().encode(stdinPayload))
  await writer.close()
  const execOut = await execProc.output()
  const runResult = {
    success: execOut.code === 0,
    output: new TextDecoder().decode(execOut.stdout),
    error: new TextDecoder().decode(execOut.stderr),
  }
  if (!runResult.success) {
    error(
      `init-models.py failed inside container:\nstdout: ${runResult.output || "<empty>"}\nstderr: ${
        runResult.error || "<empty>"
      }`,
    )
    Deno.exit(1)
  }
  log(runResult.output.trim() || "init-models.py: no output")
  success("✓ OpenWebUI provider config + model whitelist synced to DB")

  // Container restart is not strictly required — the next /api/v1/models
  // call re-reads the DB and refreshes the in-memory cache. But a restart
  // guarantees the new state is loaded before any user request, and
  // makes the deploy behaviour predictable.
  log(`Restarting ${CONTAINER} to flush in-memory model cache...`)
  const restartResult = await runCommand([
    "ssh",
    ...SSH_OPTION_ARGS,
    "--",
    SSH_TARGET,
    `docker restart ${CONTAINER}`,
  ])
  if (!restartResult.success) {
    error(`Restart failed: ${restartResult.error || restartResult.output}`)
    Deno.exit(1)
  }
  success(`✓ ${CONTAINER} restarted`)
}
