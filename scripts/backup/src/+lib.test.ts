// Guards the backup cron's remote-user key. The cron job no longer passes
// USER=... — it passes SSH_USER=... (belt-and-suspenders alongside the
// server .env it already loads) — so +lib.ts's USER export must read
// SSH_USER, not the legacy USER key. Reverting `getEnvVar("SSH_USER")` to
// `getEnvVar("USER")` here silently keeps working locally (USER is the
// shell's own env var) but breaks on a real cron, whose environment has
// no USER at all.
//
// Dynamic import with a cache-busting query string: `USER` is a
// top-level const, resolved once at module evaluation, so re-importing
// with different env vars needs a fresh module instance.

import { assertEquals, assertRejects } from "@std/assert"

async function importLibWith(env: Record<string, string>) {
  const previous = new Map<string, string | undefined>()
  for (const key of Object.keys(env)) previous.set(key, Deno.env.get(key))
  try {
    for (const [key, value] of Object.entries(env)) Deno.env.set(key, value)
    return await import(`./+lib.ts?bust=${crypto.randomUUID()}`)
  } finally {
    for (const [key, value] of previous) {
      value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value)
    }
  }
}

Deno.test("scripts/backup/src/+lib.ts: USER reads SSH_USER, not the legacy USER key", async () => {
  const mod = await importLibWith({
    SSH_USER: "deploy",
    USER: "should-be-ignored", // the shell's own USER, or a leftover cron var
    PATH_APPS: "/srv/apps",
    VOLUMES_PATH: "/srv/volumes",
    PATH_SYNC: "/srv/sync",
    SERVER_NAME: "home",
  })
  assertEquals(mod.USER, "deploy")
})

Deno.test("scripts/backup/src/+lib.ts: USER alone is not a remote user", async () => {
  const previous = Deno.env.get("SSH_USER")
  Deno.env.delete("SSH_USER")
  try {
    await assertRejects(
      () =>
        importLibWith({
          USER: "legacy",
          PATH_APPS: "/srv/apps",
          VOLUMES_PATH: "/srv/volumes",
          PATH_SYNC: "/srv/sync",
          SERVER_NAME: "home",
        }),
      Error,
      "SSH_USER",
    )
  } finally {
    if (previous !== undefined) Deno.env.set("SSH_USER", previous)
  }
})
