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
//   SSH_ADDRESS, PATH_APPS    from deploy context
//   OPENAI_API_KEYS, OPENAI_API_BASE_URLS, OPENAI_API_CONFIGS
//                            from .env via --env-file=.env
//
// On failure: exit non-zero so deploy fails loudly. Provider sync is
// not optional — without it, the service is functionally broken.

import { error, log, runCommand, success } from "../../scripts/+lib.ts"

const SSH = Deno.env.get("SSH_ADDRESS")
const PATH_APPS = Deno.env.get("PATH_APPS")
const OPENAI_API_KEYS = Deno.env.get("OPENAI_API_KEYS")
const OPENAI_API_BASE_URLS = Deno.env.get("OPENAI_API_BASE_URLS")

if (!SSH || !PATH_APPS) {
  error("after.deploy.ts: SSH_ADDRESS and PATH_APPS must be set")
  Deno.exit(1)
}
if (!OPENAI_API_KEYS || !OPENAI_API_BASE_URLS) {
  error(
    "after.deploy.ts: OPENAI_API_KEYS and OPENAI_API_BASE_URLS must be set in .env",
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
  SSH,
  `docker cp ${REMOTE_SCRIPT_SRC} ${CONTAINER}:${REMOTE_SCRIPT_TMP}`,
])
if (!cpResult.success) {
  error(`docker cp failed: ${cpResult.error || cpResult.output}`)
  Deno.exit(1)
}
success("✓ script copied")

// Run the script inside the container with the deploy-time env vars.
// Pass OPENAI_API_KEYS / OPENAI_API_BASE_URLS / OPENAI_API_CONFIGS via
// -e so the script reads the freshly-deployed values, not whatever
// stale values OWUI might have in its own env block.
log(`Running ${SCRIPT_NAME} inside ${CONTAINER}...`)

// Pass OPENAI_API_KEYS and OPENAI_API_BASE_URLS via -e (so the .env
// value wins, not any stale env from a prior container image). Do NOT
// pass OPENAI_API_CONFIGS: that var is hardcoded in compose.yml
// (servers/home/.env keeps it empty as a placeholder). The script will
// inherit OPENAI_API_CONFIGS from the container's own env, where the
// compose value lives.
const dockerArgs = [
  "ssh",
  SSH,
  `docker exec -i` +
  ` -e OPENAI_API_KEYS=${shellQuote(OPENAI_API_KEYS)}` +
  ` -e OPENAI_API_BASE_URLS=${shellQuote(OPENAI_API_BASE_URLS)}` +
  ` ${CONTAINER} python3 ${REMOTE_SCRIPT_TMP}`,
]
const runResult = await runCommand(dockerArgs)
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
  SSH,
  `docker restart ${CONTAINER}`,
])
if (!restartResult.success) {
  error(`Restart failed: ${restartResult.error || restartResult.output}`)
  Deno.exit(1)
}
success(`✓ ${CONTAINER} restarted`)

/** Quote a value for safe inclusion inside single-quoted shell strings. */
function shellQuote(s: string): string {
  // 'foo' → 'foo',  foo'bar → 'foo'\''bar'
  return `'${s.replace(/'/g, "'\\''")}'`
}
