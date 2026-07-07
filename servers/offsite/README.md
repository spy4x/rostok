# Offsite Server

Backup replication and monitoring on Raspberry Pi 4.

## Services

**Infrastructure** - [Syncthing](../../stacks/syncthing/), [Gatus](../../stacks/gatus/), [WireGuard](../../stacks/wireguard/), [Traefik](../../stacks/traefik/), [Watchtower](../../stacks/watchtower/)

## Hardware

- **Device**: Raspberry Pi 4 (4GB RAM)
- **OS**: Raspberry Pi OS (Debian-based)
- **Storage**: External HDD/SSD for backups
- **Location**: Different physical location than other servers

## Purpose

- Geographic redundancy for backups
- Independent monitoring node
- Disaster recovery capability

## Setup

Mount external storage and configure in `.env`:

```bash
OFFSITE_PATH_SYNC=/mnt/external/sync
```

Configure Syncthing to accept shared folders from home and cloud servers.

## Deployment

```bash
deno task deploy offsite
```

See main [README](../../README.md) for setup instructions.

Should be monitored by home and cloud servers via Gatus/Uptime Kuma.

Configure ntfy notifications:

```env
OFFSITE_NTFY_AUTH_TOKEN=tk_<your-token>
```

## Raspberry Pi Fixes

### Read-only Boot Partition

If apt/dnf fails with read-only filesystem errors:

```bash
# Automated fix (via initial-setup base playbook)
ansible-playbook ansible/playbooks/initial-setup/base.yml -K --limit offsite

# Manual fix
sudo mount -o remount,rw /boot/firmware
sudo dpkg --configure -a
```

### Performance

Raspberry Pi 4/5 recommended for better performance. Ensure:

- Active cooling (fan/heatsink)
- Quality power supply (official or equivalent)
- Fast SD card or boot from SSD

## Common Tasks

```bash
# Check services
docker compose ps

# View Syncthing status
docker logs syncthing

# Check disk space
df -h

# Check backup sync progress
du -sh <sync-path>/*
```

## Security

- SSH hardened via Ansible (key-only, custom port, fail2ban)
- Minimal services exposed externally
- VPN required for access to most services
- Regular security updates via Ansible maintenance playbook

## Notes

- Raspberry Pi OS (Debian-based) or Ubuntu Server recommended
- Keep firmware/packages updated:
  `ansible-playbook ansible/playbooks/initial-setup/maintenance.yml -K --limit offsite`
- Monitor temperature in hot environments (adjust thresholds in `.env`)
- Consider UPS for power redundancy in critical setups
