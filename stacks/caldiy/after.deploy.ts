// after.deploy.ts — Ensure Cal.diy booking confirmation workflow exists.
// Runs after docker compose up. SSHs into the server and uses psql to
// create the Workflow + WorkflowStep + WorkflowsOnEventTypes records if
// they don't already exist. This avoids manual SQL steps.
//
// Environment: SSH_HOST, SSH_PORT, SSH_USER, PATH_APPS from deploy
// context. SSH_HOST/SSH_PORT/SSH_USER are contract keys parsed once from
// SSH_ADDRESS by cli/deploy/hooks.ts's buildHookEnv (#229) — see its
// module comment. Building ssh's argv from these instead of the raw
// SSH_ADDRESS string is what lets a non-default port reach ssh as
// `-p <port>` instead of being read as part of an unresolvable
// "host:port" hostname. SSH_PORT is set ONLY when SSH_ADDRESS carried an
// explicit port — never a default — so `-p` is added only when it's
// non-empty.

/** Digits only, 1-65535 — the same range cli/server-keys.ts's parseSshAddress enforces. */
function isValidPort(port: string): boolean {
  if (!/^\d+$/.test(port)) return false
  const n = Number(port)
  return n >= 1 && n <= 65535
}

/**
 * Build the argv for `ssh [-p <port>] -o ConnectTimeout=10 -o
 * BatchMode=yes -- [user@]host <remoteCommand>`. `port` is omitted from
 * the argv entirely when undefined (SSH_ADDRESS had no explicit port) —
 * a hook must never invent a default port a bare alias's own
 * ~/.ssh/config might already override. Throws if `port` is set but not
 * a valid 1-65535 port — defense in depth even though SSH_ADDRESS was
 * already validated once before deploy ever set SSH_PORT. Exported for
 * tests — no I/O. See cli/deploy/hooks.ts's module comment (#229).
 */
export function buildSshArgs(
  host: string,
  port: string | undefined,
  user: string | undefined,
  remoteCommand: string,
): string[] {
  if (port !== undefined && !isValidPort(port)) {
    throw new Error(`invalid SSH_PORT "${port}": expected digits 1-65535`)
  }
  const target = user ? `${user}@${host}` : host
  return [
    ...(port !== undefined ? ["-p", port] : []),
    "-o",
    "ConnectTimeout=10",
    "-o",
    "BatchMode=yes",
    "--",
    target,
    remoteCommand,
  ]
}

const SSH_HOST = Deno.env.get("SSH_HOST") ?? ""
const SSH_PORT = Deno.env.get("SSH_PORT") || undefined
const SSH_USER = Deno.env.get("SSH_USER") || undefined
const APPS = Deno.env.get("PATH_APPS") ?? ""

if (import.meta.main && (!SSH_HOST || !APPS)) {
  console.error("after.deploy.ts: SSH_HOST and PATH_APPS must be set")
  Deno.exit(1)
}

/** Run SQL via psql on the remote caldiy-db container, return stdout */
async function psql(sql: string): Promise<string> {
  const proc = new Deno.Command("ssh", {
    args: buildSshArgs(
      SSH_HOST,
      SSH_PORT,
      SSH_USER,
      "docker exec -i hl-caldiy-db psql -U caldiy -d caldiy -t -A",
    ),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  })
  const child = proc.spawn()
  const writer = child.stdin.getWriter()
  await writer.write(new TextEncoder().encode(sql))
  await writer.close()
  const out = await child.output()
  if (out.code !== 0) {
    const stderr = new TextDecoder().decode(out.stderr).trim()
    throw new Error(`psql exited ${out.code}: ${stderr}`)
  }
  const stdout = new TextDecoder().decode(out.stdout).trim()
  // Remove psql notice lines (BEGIN, INSERT, COMMIT etc.)
  const lines = stdout.split("\n").filter((l) =>
    !/^(BEGIN|INSERT|DELETE|UPDATE|COMMIT|ROLLBACK|DO)$/i.test(l.trim())
  )
  return lines.join("\n").trim()
}

async function main() {
  // Step 1: check if the caldiy-db container is reachable
  console.log("Connecting to caldiy-db...")
  const ping = await psql("SELECT 1 AS ok")
  if (ping !== "1") {
    throw new Error(`cannot reach caldiy-db, got: ${ping}`)
  }
  console.log("✓ Connection OK")

  // Step 2: check if workflow already exists
  const existing = await psql(
    `SELECT id FROM "Workflow" WHERE trigger = 'NEW_EVENT' AND name = 'Booking Confirmation' LIMIT 1`,
  )
  if (existing) {
    console.log(`✓ Booking Confirmation workflow already exists (id=${existing}) — nothing to do`)
    return
  }

  // Step 3: create workflow in a transaction
  console.log("Creating Booking Confirmation workflow...")

  await psql(`
BEGIN;

INSERT INTO "Workflow" (name, "userId", trigger, time, "timeUnit", position, "isActiveOnAll", type)
VALUES ('Booking Confirmation', 1, 'NEW_EVENT', NULL, NULL, 0, false, 'EVENT_TYPE');

DO $$
DECLARE
  wid INTEGER;
BEGIN
  SELECT lastval() INTO wid;

  INSERT INTO "WorkflowStep" ("stepNumber", action, "workflowId", template, sender, "includeCalendarEvent", "verifiedAt")
  VALUES (1, 'EMAIL_HOST', wid, 'REMINDER', 'Cal.com', false, NOW());

  INSERT INTO "WorkflowStep" ("stepNumber", action, "workflowId", template, sender, "includeCalendarEvent", "verifiedAt")
  VALUES (2, 'EMAIL_ATTENDEE', wid, 'REMINDER', 'Cal.com', false, NOW());

  INSERT INTO "WorkflowsOnEventTypes" ("workflowId", "eventTypeId")
  SELECT wid, id FROM "EventType" WHERE slug != 'secret' AND slug != '';
END $$;

COMMIT;
`)

  // Step 4: verify
  const verify = await psql(
    `SELECT format('id=%s, name=%s, trigger=%s, steps=%s',
       w.id, w.name, w.trigger, count(ws.id))
     FROM "Workflow" w
     JOIN "WorkflowStep" ws ON ws."workflowId" = w.id
     WHERE w.trigger = 'NEW_EVENT' AND w.name = 'Booking Confirmation'
     GROUP BY w.id, w.name, w.trigger`,
  )

  if (verify) {
    console.log(`✅ Created: ${verify}`)
  } else {
    // Fallback: check count
    const count = await psql(`SELECT count(*) FROM "Workflow" WHERE trigger = 'NEW_EVENT'`)
    console.log(`✅ Workflow created (total NEW_EVENT workflows: ${count})`)
  }
}

if (import.meta.main) {
  try {
    await main()
  } catch (err) {
    console.error("after.deploy.ts FAILED:", err instanceof Error ? err.message : String(err))
    Deno.exit(1)
  }
}
