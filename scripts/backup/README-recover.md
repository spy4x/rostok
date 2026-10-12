# Backup Recovery Tool

Recovers restic repositories from snapshot blob corruption (typically caused by disk full mid-write).

## When to use

Backup fails with errors like:

- `error: error loading index <hash>: ciphertext verification failed`
- `Fatal: config or key <hash> is damaged: ciphertext verification failed`
- `repository index is damaged and must be repaired`

Common causes:

- Disk ran out of space mid-backup → snapshot blobs partially written → corrupted
- Filesystem corruption (run `sudo e2fsck -n` to check)
- SSD bit rot (run `sudo smartctl -a /dev/nvme0n1`)

## Usage

```bash
# Scan and report what needs recovery (no changes)
deno run -A --env-file=<env file> scripts/backup/recover.ts --dry-run

# Actually recover (will prompt for confirmation)
deno run -A --env-file=<env file> scripts/backup/recover.ts
```

`<env file>` is the one the nightly backup's cron line passes. The script reads
no env file by itself.

## What it does

For each repo under `~/sync/backups/`:

1. **healthy** — no action
2. **partial** (some snapshots corrupted, some good): deletes `snapshots/`, `index/`, `locks/` subdirs, runs `restic repair index`. Pack files (actual data) are preserved. Loss: snapshot history. Next backup creates fresh snapshot.
3. **broken** (config blob corrupted, can't enumerate): removes repo dir, runs `restic init`. Loss: ALL DATA. Must re-run backup to repopulate.

## Requirements

- `BACKUPS_PASSWORD` and `PATH_BACKUPS` env vars, from the env file you pass
  (in a rostok project: `.env.root` and `servers/<server>/.env`)
- `restic` installed (`brew install restic` / `apt install restic`)

## Recovery vs password rotation

If password was rotated (uncommitted manual rotation), old snapshots remain encrypted with old password and cannot be recovered even with this tool — restic can't decrypt blobs without the correct password. Verify password hasn't changed:

```bash
# In your rostok project: when did the encrypted value last change?
git log -p -- .env.root.age | grep BACKUPS_PASSWORD
```

To read an old value, check out that commit in a worktree of your project and
run `rostok env decrypt` there.

## Related: post-recovery cleanup

After running recovery and re-running backups successfully:

- Remove old, orphaned worktrees: `git worktree list`, then `git worktree remove <path> && git branch -d <branch>`
- Investigate disk usage: `df -h`, `ncdu ~/sync/backups/`
- Add disk space alerts (see `docs/usage/disaster-recovery.md`)
