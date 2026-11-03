# Disaster recovery

What to do when a server dies, data corrupts or a stack breaks. This is generic guidance: your
exact backup targets and runbook belong in your own rostok project.

## Backup architecture

Each stack with data declares what to back up in its `stacks/<name>/backup.ts`; your own folders
go in `servers/<server>/configs/backup/*.backup.ts` in your project. The backup runner
(`scripts/backup/+main.ts`, see its [README](../../scripts/backup/README.md)) stops each stack,
writes a restic snapshot and starts the stack again. rostok does not install the runner: clone a
release tag on the server and add the cron line its README shows.

```
                      ┌──────────────────────────┐
                      │  backup runner (cron)    │
                      │  one restic repository   │
                      │  per backup name         │
                      └────────────┬─────────────┘
                                   ▼
┌──────────────────────┐   ┌────────────────────┐   ┌─────────────────────────┐
│ ${PATH_BACKUPS}/     │──▶│ a second server,   │   │ external drive          │
│ <name> on the server │   │ if you sync the    │   │ `rostok offline backup` │
│                      │   │ folder (syncthing) │   │ from your machine       │
└──────────────────────┘   └────────────────────┘   └─────────────────────────┘
```

Only the first copy is automatic. Keep at least one more: sync `PATH_BACKUPS` to another server
(for example with the [syncthing](../../stacks/syncthing/README.md) stack) and copy it to an
external drive with `rostok offline backup --drive <disk>` (see [commands](../commands.md)). With
three copies in three places, any single failure (a dead server, a lost account, an accidental
`rm -rf`) is recoverable.

Every repository uses the password `BACKUPS_PASSWORD` from the server's env file. Keep that
password somewhere outside the server too: without it no copy can be read.

The runner reports failures to ntfy and every run to healthchecks ([monitoring](monitoring.md)).

## Scenario 1 — single service lost data

If one stack's volume is corrupted or wiped, restore it with `scripts/backup/restore.ts`. Run it
on the server, as the same user and with the same `--env-file` arguments as the backup's cron line:

```bash
deno run -A --env-file=<env file> scripts/backup/restore.ts <service>              # latest snapshot
deno run -A --env-file=<env file> scripts/backup/restore.ts <service> <snapshot-id>
```

`<service>` is the backup's `name`; a wrong name lists the valid ones. The script shows which
folders it will replace and waits for `yes`. Then it stops the stack's containers, unpacks the
snapshot next to each folder, moves the old data aside as `<folder>.backup-<time>`, puts the
restored data in place, fixes ownership and starts the containers again, also when the restore
failed. Check that the service works, then delete the `.backup-<time>` folders.

To look inside a snapshot first, use restic directly. It asks for the repository password,
`BACKUPS_PASSWORD`, unless `RESTIC_PASSWORD` holds it:

```bash
restic -r ${PATH_BACKUPS}/<name> snapshots
restic -r ${PATH_BACKUPS}/<name> restore <snapshot-id> --target /tmp/restore-test
```

For stacks whose app has its own restore (a Postgres dump, for example), you can use that instead.

## Scenario 2 — server hardware failure

If the server itself is gone:

1. **Provision** a new host with the same OS, SSH user and paths (`PATH_APPS`, `VOLUMES_PATH`,
   `PATH_BACKUPS`). If its SSH address changed, run `rostok server create <name>` again: it keeps
   every other value from the server's `.env` and asks only what you change.

2. **Deploy** the same stacks from your rostok project: `rostok deploy <server>` copies each
   stack's files, the env files and your `configs/` to the new host and starts the stacks with
   empty data.

3. **Bring the backup repositories back** to `PATH_BACKUPS`: from the second server, or from the
   external drive with `rostok offline restore --drive <disk>`, which copies them back and checks
   them. Run `restic -r ${PATH_BACKUPS}/<name> snapshots` on one to confirm it opens.

4. **Restore each stack** with `scripts/backup/restore.ts <service>` as in Scenario 1, from a clone
   of the backup runner on the new host.

5. **Update DNS** if the server's public IP changed. (A Hetzner floating IP avoids that: point the
   same IP at the new server.)

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
# on the server, with the env file the backup's cron line passes
deno run -A --env-file=<env file> scripts/backup/recover.ts --dry-run   # report only
deno run -A --env-file=<env file> scripts/backup/recover.ts             # repair, asks first
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
   rostok env encrypt
   ```

4. **Redeploy** with `rostok deploy <server>` so the running services pick up the new value.

5. **Audit** `git log -p` for the old value to confirm it's gone from
   history. If not, `git filter-repo` to scrub.

## Preventive habits

- **Test restore quarterly.** Pick one stack, restore from backup to a
  throwaway container, verify. A backup you haven't restored from is
  not a backup.
- **Verify external drive monthly.** Plug it in and run
  `rostok offline verify --drive <disk>`: it checks the repositories, runs
  a SMART test and ejects cleanly. Drives left in a drawer for years fail
  silently.
- **Rotate the age key annually.** Store the previous key in a password
  manager for one rotation cycle in case you need to decrypt old
  `.env.age` files.
- **Document off-board runbooks.** If you die / get hit by a bus,
  someone else needs to know where the backups live and how to
  decrypt them. Single piece of paper in a safe works.

## What this doc is NOT

- A specific server's runbook. Each user has a different layout, backup targets and repository
  paths. Keep your runbook in your own rostok project, next to the servers it describes, and keep
  a copy somewhere you can read when that project's machine is gone.
- A replacement for actual backups. Verify the chain works before you need it.
