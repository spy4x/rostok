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
const SCRIPT_PATH = `stacks/open-webui/${SCRIPT_NAME}`
const CONTAINER = "hl-open-webui"
const REMOTE_SCRIPT_PATH = `/tmp/${SCRIPT_NAME}`

// Verify the script is present in the staged tempDir (deploy script
// copies the stack here before rsyncing). The path is relative to
// Deno.cwd() which the deploy script sets to the tempDir.
try {
  const stat = await Deno.stat(SCRIPT_PATH)
  if (!stat.isFile) {
    error(`after.deploy.ts: ${SCRIPT_PATH} is not a file`)
    Deno.exit(1)
  }
} catch (err) {
  if (err instanceof Deno.errors.NotFound) {
    error(`after.deploy.ts: ${SCRIPT_PATH} not found in tempDir (cwd=${Deno.cwd()})`)
  } else {
    error(`after.deploy.ts: stat failed: ${err}`)
  }
  Deno.exit(1)
}

log(`Copying ${SCRIPT_PATH} → ${CONTAINER}:${REMOTE_SCRIPT_PATH}...`)
const cpResult = await runCommand([
  "ssh",
  SSH,
  `docker cp ${SCRIPT_PATH} ${CONTAINER}:${REMOTE_SCRIPT_PATH}`,
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
const cfgs = Deno.env.get("OPENAI_API_CONFIGS") ?? ""

const dockerArgs = [
  "ssh",
  SSH,
  // Chain docker exec -e to forward env, then run the script. The
  // script reads its own env, no shell expansion needed.
  `docker exec -i` +
  ` -e OPENAI_API_KEYS=${shellQuote(OPENAI_API_KEYS)}` +
  ` -e OPENAI_API_BASE_URLS=${shellQuote(OPENAI_API_BASE_URLS)}` +
  ` -e OPENAI_API_CONFIGS=${shellQuote(cfgs)}` +
  ` ${CONTAINER} python3 ${REMOTE_SCRIPT_PATH}`,
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
