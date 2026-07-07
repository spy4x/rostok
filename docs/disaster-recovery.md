# Disaster Recovery

Recovery procedures for each server, Restic restore instructions, and DNS failover.

## Server Inventory

| Server | Host | OS | Location | Purpose |
|---|---|---|---|---|
| home | 165.173.1.38 | Fedora | Home LAN | Primary services (47 stacks) |
| cloud | 23.88.101.28 | Hetzner VPS | Germany | Email, health monitoring, public services |
| offsite | 213.21.10.17 | Raspberry Pi 4 | Remote | Backup replication, monitoring node |

## Backup Architecture

```
Service volumes → Restic → Local repo → Syncthing → Cloud + Offsite
                                              ↘ ntfy notification
```

- **Tool**: [Restic](https://restic.readthedocs.io/) — encrypted, deduplicated backups
- **Frequency**: Daily via cron (2:30am on each server)
- **Replication**: Syncthing syncs repos to other servers
- **Retention**: 7 daily, 4 weekly, 3 monthly snapshots
- **Automation**: `deno task backup` — see [backup README](../scripts/backup/README.md)

### Backup Locations

| Server | Repo path | Replicated to |
|---|---|---|
| home | `~/sync/backups/*` | cloud, offsite |
| cloud | `~/sync/backups/*` | home, offsite |
| offsite | `/mnt/external/sync/backups/*` | none (last resort) |

## Full Server Recovery

### Scenario: Server completely lost (hardware failure, theft, OS corruption)

#### 1. Provision new server

```bash
# For Hetzner: deploy new VPS with Fedora
# For home server: install Fedora, enable SSH
# For RPi: flash Raspberry Pi OS, enable SSH

# Copy ansible inventory from backup or recreate:
# ansible/inventory.yml
```

#### 2. Run Ansible initial setup

```bash
deno task ansible ansible/playbooks/initial-setup/maintenance.yml -K --limit <server>
```

This configures:
- SSH hardening (key-only, custom port, fail2ban)
- Docker installation
- System packages
- Firewall rules

#### 3. Restore `.env` from encrypted backup

```bash
# Decrypt .env.age (stored in git)
deno task env:decrypt

# Or restore from Syncthing backup:
restic -r ~/sync/backups/env-<server> restore latest --target ~/
```

#### 4. Deploy base infrastructure

```bash
deno task deploy <server> traefik
deno task deploy <server> syncthing
deno task deploy <server> watchtower
```

#### 5. Restore Syncthing config

```bash
# Wait for Syncthing to sync, then check:
restic -r ~/sync/backups/syncthing-<server> snapshots
restic -r ~/sync/backups/syncthing-<server> restore latest --target ~/
```

#### 6. Deploy all services

```bash
deno task deploy <server>
```

#### 7. Restore service data from Restic

For each service with data:

```bash
# List available snapshots
restic -r ~/sync/backups/<service> snapshots

# Find the latest snapshot before failure
restic -r ~/sync/backups/<service> restore <snapshot-id> --target ~/ssd-2tb/apps/.volumes/<service>/
```

**Key services to restore** (order matters):

| Priority | Service | Data volume | Restore command |
|---|---|---|---|
| 1 | vaultwarden | `~/.volumes/vaultwarden/` | Passwords — restore first, everything else depends on it |
| 2 | immich | `~/.volumes/immich/` | Photos — large dataset, longest restore time |
| 3 | gitea | `~/.volumes/gitea/` | Git repos — restore before deploying |
| 4 | authelia | `~/.volumes/authelia/` | Auth config + 2FA sessions |
| 5 | paperless-ngx | `~/.volumes/paperless/` | Documents |
| 6 | jellyfin | `~/.volumes/jellyfin/` | Media metadata |
| 7 | victoria-metrics | `~/.volumes/victoria-metrics/`, `~/.volumes/victoria-logs/` | Metrics + logs |

#### 8. Restore Gatus config + re-enable cross-server monitoring

```bash
deno task deploy <server> gatus
```

#### 9. Verify

```bash
# Check all services
docker compose ps

# Check backups
deno task backup --dry-run

# Check monitoring
curl https://uptime-cloud.${DOMAIN}/api/v1/endpoints
```

## Single-Service Recovery

### Scenario: One service's data corrupted

#### 1. Identify the backup repo

```bash
ls ~/sync/backups/ | grep <service-name>
```

#### 2. List snapshots

```bash
RESTIC_PASSWORD="your-backup-password" restic -r ~/sync/backups/<service> snapshots
```

#### 3. Restore to temp directory

```bash
RESTIC_PASSWORD="your-backup-password" restic -r ~/sync/backups/<service> restore <snapshot-id> --target /tmp/restore-<service>
```

#### 4. Stop the service and restore data

```bash
docker compose -f ~/ssd-2tb/apps/stacks/<service>/compose.yml down

# Copy restored data to volume directory
cp -a /tmp/restore-<service>/path/to/data ~/.volumes/<service>/

# Restart
docker compose -f ~/ssd-2tb/apps/stacks/<service>/compose.yml up -d
```

#### 5. Verify

```bash
# Check logs
docker logs <container-name> --tail 50

# Check the service works
curl https://<service>.${DOMAIN}
```

#### 6. Cleanup

```bash
rm -rf /tmp/restore-<service>
```

## Database-Specific Restore

### PostgreSQL (Gitea, Paperless-ngx, Woodpecker)

```bash
# Restore data directory
RESTIC_PASSWORD="..." restic -r ~/sync/backups/<service> restore latest --target /tmp/pg-restore

# Copy data
cp -a /tmp/pg-restore/path/to/pgdata ~/.volumes/<service>/pgdata/

# Or restore from dump if available:
docker exec -i <db-container> psql -U <user> <dbname> < /path/to/dump.sql
```

### SQLite (Immich microservices, Vaultwarden, Gatus, many others)

```bash
# Just restore the .db file from the volume backup
RESTIC_PASSWORD="..." restic -r ~/sync/backups/<service> restore latest --target /tmp/sqlite-restore
cp -a /tmp/sqlite-restore/path/to/data ~/.volumes/<service>/
```

### VictoriaMetrics / VictoriaLogs

```bash
# Stop VM before restore to prevent corruption
docker stop hl-victoria-metrics hl-victoria-logs

RESTIC_PASSWORD="..." restic -r ~/sync/backups/victoria-metrics restore latest \
  --target ~/.volumes/victoria-metrics/

RESTIC_PASSWORD="..." restic -r ~/sync/backups/victoria-logs restore latest \
  --target ~/.volumes/victoria-logs/

docker start hl-victoria-metrics hl-victoria-logs
```

## DNS Failover

### Default routing

```
*.antonshubin.com → (wildcard A record) → home server (165.173.1.38)
```

Cloud and offsite servers have explicit A records.

### If home server goes down

1. **Update Cloudflare DNS** — point critical service subdomains to cloud server:

```bash
# Examples: redirect passwords, git, docs to cloud
CF_TOKEN=$(grep CLOUDFLARE_API_TOKEN .env.root | cut -d= -f2)
ZONE_ID=$(curl -s -X GET "https://api.cloudflare.com/client/v4/zones?name=antonshubin.com" \
  -H "Authorization: Bearer $CF_TOKEN" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['result'][0]['id'])")

# Create A records pointing to cloud for critical services
for sub in passwords git docs analytics; do
  curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records" \
    -H "Authorization: Bearer $CF_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"A\",\"name\":\"$sub\",\"content\":\"23.88.101.28\",\"ttl\":1,\"proxied\":false}"
done
```

2. **These services won't work on cloud** (no data) — only documentation and
   static sites can serve from cloud:

   | Can serve from cloud | Cannot (no data on cloud) |
   |---|---|
   | dash.${DOMAIN} | passwords.${DOMAIN} (Vaultwarden) |
   | antonshubin.com | git.${DOMAIN} (Gitea) |
   | neatsoft.dev | docs.${DOMAIN} (Paperless) |
   | uptime-home.${DOMAIN} | photos.${DOMAIN} (Immich) |

3. **Restore home server** per "Full Server Recovery" above.

### If cloud server goes down

No data loss — cloud runs email and healthchecks, all data is also on home server.

1. **Email**: Queues in sending MTA will retry. No action needed for <24h outage.
2. **Monitoring**: Home Gatus still monitors offsite services.
3. **Recovery**: Provision new Hetzner VPS, run ansible, deploy.

### If offsite server goes down

1. No immediate impact — backups are replicated to cloud as well.
2. **Recovery**: Check RPi hardware (power, SD card, network). Re-flash if needed.

## Key Commands Reference

```bash
# List all backup repos on current server
ls ~/sync/backups/

# List snapshots for a service
RESTIC_PASSWORD="..." restic -r ~/sync/backups/<service> snapshots

# Restore latest snapshot to a directory
RESTIC_PASSWORD="..." restic -r ~/sync/backups/<service> restore latest --target <dir>

# Restore specific files only
RESTIC_PASSWORD="..." restic -r ~/sync/backups/<service> restore latest \
  --target <dir> --include "path/to/specific/file"

# Check repository integrity
RESTIC_PASSWORD="..." restic -r ~/sync/backups/<service> check

# Mount a backup as FUSE filesystem
RESTIC_PASSWORD="..." restic -r ~/sync/backups/<service> mount /mnt/restic

# Run backup system
deno task backup

# Deploy all services to a server
deno task deploy <server>

# Deploy specific stack
deno task deploy <server> <stack>
```

## Prevention

- **Automated daily backups** — cron on every server
- **Cross-server monitoring** — Gatus on home + cloud
- **Recovery drills** — test restoring one service per quarter
- **Healthchecks** — cron job monitoring via healthchecks.${DOMAIN}
- **Watchtower** — automatic container updates
- **Disaster recovery plan** — this document (review quarterly)

## References

- [Backup system docs](../scripts/backup/README.md)
- [Architecture overview](architecture.md)
- [Restic documentation](https://restic.readthedocs.io/)
- [Syncthing documentation](https://docs.syncthing.net/)
- [Cloudflare DNS API](https://api.cloudflare.com/#dns-records-for-a-zone)
