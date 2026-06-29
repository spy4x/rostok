# Home Server

Local media, automation, productivity, and self-hosted services.

**⚠️ Reliability:** This is an old gaming PC with a dying SATA SSD (to be replaced soon). Prone to electricity outages and internet disruptions. Critical services (email, external-facing) run on the [cloud server](../cloud/README.md).

## Services

**Media** - [Jellyfin](docs/jellyfin.md), [Immich](docs/immich.md), [Audiobookshelf](docs/audiobookshelf.md), [MeTube](docs/metube.md), [Transmission](docs/transmission.md)\
**Productivity** - [Vaultwarden](docs/vaultwarden.md), [FreshRSS](docs/freshrss.md), [FileBrowser](docs/filebrowser.md), [Open WebUI](docs/open-webui.md)\
**Automation** - [Home Assistant](docs/home-assistant.md), [AdGuard Home](docs/adguard.md)\
**Infrastructure** - [Traefik](../../sharedStacks/traefik/), [Gatus](../../sharedStacks/gatus/), [Syncthing](../../sharedStacks/syncthing/), [WireGuard](../../sharedStacks/wireguard/), [Watchtower](../../sharedStacks/watchtower/), [ntfy](../../sharedStacks/ntfy/), [Woodpecker CI](docs/woodpecker.md)

## Hardware

- **OS**: Fedora 40 (old gaming PC, to be replaced)
- **Storage**: Dying SATA SSD + external drives
- **Network**: Gigabit ethernet (residential, periodic outages)

## Quick Access

Dashboard: `https://dash.${DOMAIN}`

See individual service docs in [docs/](docs/) for configuration details.

## Deployment

```bash
deno task deploy home
```

See main [README](../../README.md) for setup instructions.

- Hardware alerts (disk space, SSD health, temperature)
- Security (SSH failed logins, fail2ban bans)
- Backup status

Configure tokens in `.env`:

```env
HOME_NTFY_AUTH_TOKEN=tk_<your-token>
```

## Fedora-Specific

### Docker External Access Fix

If containers aren't accessible externally:

```bash
sudo iptables -I DOCKER-USER -j ACCEPT
```

Make permanent with systemd service (see `README_FEDORA.md`).

### SMART Monitoring

NVMe/SSD health monitoring with ntfy alerts. Configured via Ansible:

```bash
ansible-playbook ansible/playbooks/smart-monitoring.yml -K --limit home
```

## Common Tasks

```bash
# Check service status
docker compose ps

# Restart service
docker compose restart <service>

# View logs
docker compose logs -f <service>

# Update all containers
docker compose pull && docker compose up -d

# Check disk space
df -h

# Check Docker disk usage
docker system df
```

## Troubleshooting

### External Access Not Working

See `README_FEDORA.md` for Docker networking fix.

### Container Won't Start

```bash
# Check logs
docker logs <container>

# Check resources
docker stats

# Verify .env file
cat .env | grep -v "^#"
```

### Storage Issues

```bash
# Clean Docker system
docker system prune -a --volumes

# Check disk usage by directory
du -sh .volumes/*
```

## Notes

- All services behind Traefik reverse proxy with automatic SSL
- Cloudflare can be used for DNS (set proxy off for mail)
- VPN gives access to all services remotely
- AdGuard DNS should be configured on all devices for ad blocking
- Syncthing syncs backups to cloud and offsite servers
