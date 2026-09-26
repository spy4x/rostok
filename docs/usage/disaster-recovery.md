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

## Scenario 3 — failing system disk, Docker still on it

Signs: containers crash with `SIGBUS` or "Input/output error" on files inside
their image, and the kernel log shows medium errors (`journalctl -k | grep
"I/O error"`). Docker keeps images and container layers under
`/var/lib/docker`, on the system disk by default. Move them to a healthy disk
(`/mnt/data/docker` below) before the disk dies completely. All containers
stop for a few minutes. The steps assume the `overlay2` storage driver: with
the containerd image store, images live in `/var/lib/containerd` and do not
move with `data-root`.

```bash
docker info --format '{{.Driver}}'   # must print overlay2
NEW=/mnt/data/docker
sudo mkdir -p "$NEW" && sudo chmod 710 "$NEW"
# 1. Copy while Docker runs; a few "vanished" files are normal.
sudo rsync -aHAX --numeric-ids --delete /var/lib/docker/ "$NEW"/
# 2. Stop Docker and copy what changed.
sudo systemctl stop docker.socket docker
sudo rsync -aHAX --numeric-ids --delete /var/lib/docker/ "$NEW"/ 2> rsync.err
grep "Input/output error" rsync.err   # files lost to bad sectors, see below
# 3. Point Docker at the new path: add this key to the JSON object in
#    /etc/docker/daemon.json (create the file as {"data-root": "..."} if absent)
#      "data-root": "/mnt/data/docker"
# 4. SELinux hosts: label the new path like /var/lib/docker.
sudo semanage fcontext -a -e /var/lib/docker "$NEW" && sudo restorecon -R "$NEW"
# 5. Start Docker only after the disk is mounted.
sudo mkdir -p /etc/systemd/system/docker.service.d
printf '[Unit]\nRequiresMountsFor=/mnt/data\n' |
  sudo tee /etc/systemd/system/docker.service.d/data-root-mount.conf
# 6. Keep the old copy for rollback, then start.
sudo mv /var/lib/docker /var/lib/docker.old
sudo systemctl daemon-reload && sudo systemctl start docker
docker info --format '{{.DockerRootDir}}'
```

The copy skips files it cannot read. For each "Input/output error" line: a
file under `image/` or `overlay2/` belongs to an image, so remove the image and
pull it again (`docker rmi`, then redeploy the stack); a file under `volumes/`
or `containers/` is data, so restore it from backup (Scenario 1) before
deleting the old copy.

Rollback: stop Docker, remove `data-root`, move `/var/lib/docker.old` back,
start Docker.
Delete `/var/lib/docker.old` once everything has run for a few days.

## Scenario 4 — corrupted Restic repo

Restic repos can corrupt from disk errors or interrupted writes.
The bundled `scripts/backup/recover.ts` scans for corruption:

```bash
deno task backup:recover:dry-run          # report only
deno task backup:recover -- --execute     # attempt repair
```

If repair fails, fall back to the cross-server copy or the external
drive. Always keep at least two of the three backup locations.

## Scenario 5 — accidental secret commit

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