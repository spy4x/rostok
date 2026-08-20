# Disaster recovery

What to do when things go wrong — server dies, data corrupts, a stack
breaks. Generic guidance. Your exact backup targets, restore steps,
and runbooks live in the per-stack READMEs and in your project's
private docs (this is a rostok repo, not your runbook).

## Backup architecture

rostok's default backup chain (configured per-stack via
`stacks/<name>/backup.ts` and aggregated by `scripts/backup/`):

```
                       ┌─────────────────┐
                       │  per-service    │
                       │  backup.ts      │
                       │  (Restic)       │
                       └────────┬────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌──────────────┐       ┌──────────────────┐     ┌─────────────────┐
│ on-server    │       │  cross-server    │     │  external drive │
│ Restic repo  │──────▶│  Restic repo     │────▶│  monthly        │
│ (daily)      │       │  (Syncthing)     │     │  offline copy   │
└──────────────┘       └──────────────────┘     └─────────────────┘
```

Three copies, three locations. Any single failure (server crash, ISP
outage, accidental `rm -rf`) is recoverable.

## Scenario 1 — single service lost data

If one container's volume is corrupted or wiped:

1. **Stop the service** to avoid writes during restore:
   ```bash
   deno task deploy <server> --stop <stack>
   ```

2. **Identify the backup ID** for that stack. Each `backup.ts` declares
   a `sourcePaths`; the Restic repo has snapshots timestamped by day.

3. **Restore** to a temporary path first to verify:
   ```bash
   restic -r /path/to/repo restore <snapshot-id> \
     --target /tmp/restore-test --include <volume-name>
   ```
   Verify the data looks right (`ls`, sample files).

4. **Replace** the live volume. The simplest path is `docker compose
   stop <service>` then copy back. For stateful services that have
   a built-in restore (Postgres `pg_restore`, Vaultwarden
   `sqlite3 .backup`), prefer that.

5. **Restart** and verify health:
   ```bash
   deno task deploy <server> <stack>
   ```

## Scenario 2 — server hardware failure

If the box itself is gone:

1. **Provision** a new host. Same OS, same SSH user, same data layout.
   `rostok server create <name>` (once v1 ships) or manual setup for
   now.

2. **Pull the backup repo** from cross-server Syncthing or from the
   external drive. Verify you can `restic snapshots` against it.

3. **Restore the on-disk layout** — `${VOLUMES_PATH}/<stack>/` for each
   service. Use `restic restore latest --target /`.

4. **Re-deploy** the same stacks. `deno task deploy <server>` runs the
   deploy script which restores `docker compose.yml`, the env files,
   and any per-stack config from the backup.

5. **Update DNS** if the server's public IP changed. (Hetzner
   floating IPs help — point the same IP at the new box, no DNS
   change.)

## Scenario 3 — corrupted Restic repo

Restic repos can corrupt from disk errors or interrupted writes.
The bundled `scripts/backup/recover.ts` scans for corruption:

```bash
deno task backup:recover:dry-run          # report only
deno task backup:recover -- --execute     # attempt repair
```

If repair fails, fall back to the cross-server copy or the external
drive. Always keep at least two of the three backup locations.

## Scenario 4 — accidental secret commit

If a secret was committed (even age64-encrypted keys are bad if the
key leaks):

1. **Rotate the secret** at the source. Generate a new password / token
   / API key.

2. **Update** `.env` with the new value.

3. **Re-encrypt** and commit:
   ```bash
   deno task env:encrypt
   ```

4. **Redeploy** to make the running services pick up the new value.

5. **Audit** `git log -p` for the old value to confirm it's gone from
   history. If not, `git filter-repo` to scrub.

## Preventive habits

- **Test restore quarterly.** Pick one stack, restore from backup to a
  throwaway container, verify. A backup you haven't restored from is
  not a backup.
- **Verify external drive monthly.** Plug it in, check the files,
  eject cleanly. Drives left in a drawer for years fail silently.
- **Rotate the age key annually.** Store the previous key in a password
  manager for one rotation cycle in case you need to decrypt old
  `.env.age` files.
- **Document off-board runbooks.** If you die / get hit by a bus,
  someone else needs to know where the backups live and how to
  decrypt them. Single piece of paper in a safe works.

## What this doc is NOT

- A specific server's runbook. Each user has different topology,
  backup targets, Restic repo paths. Keep your runbook in your own
  project folder (it's gitignored, so it stays local).
- A replacement for actual backups. Verify the chain works before you
  need it.