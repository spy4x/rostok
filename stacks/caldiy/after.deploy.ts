// after.deploy.ts — Ensure Cal.diy booking confirmation workflow exists.
// Runs after docker compose up. SSHs into the server and uses psql to
// create the Workflow + WorkflowStep + WorkflowsOnEventTypes records if
// they don't already exist. This avoids manual SQL steps.
//
// Environment: SSH_ADDRESS, PATH_APPS from deploy context.

const SSH = Deno.env.get("SSH_ADDRESS") ?? ""
const APPS = Deno.env.get("PATH_APPS") ?? ""

if (!SSH || !APPS) {
  console.error("after.deploy.ts: SSH_ADDRESS and PATH_APPS must be set")
  Deno.exit(1)
}

/** Run SQL via psql on the remote caldiy-db container, return stdout */
async function psql(sql: string): Promise<string> {
  const proc = new Deno.Command("ssh", {
    args: [SSH, "docker exec -i hl-caldiy-db psql -U caldiy -d caldiy -t -A"],
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
  const lines = stdout.split("\n").filter(l => !/^(BEGIN|INSERT|DELETE|UPDATE|COMMIT|ROLLBACK|DO)$/i.test(l.trim()))
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

try {
  await main()
} catch (err) {
  console.error("after.deploy.ts FAILED:", err instanceof Error ? err.message : String(err))
  Deno.exit(1)
}
