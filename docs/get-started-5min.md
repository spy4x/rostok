# Quick Start

Deploy your first self-hosted server in minutes.

## Prerequisites

- Linux server with Docker installed
- SSH key access configured
- Domain with DNS pointed to server IP
- Deno installed locally

## Setup

```bash
# 1. Clone & configure
git clone <repo-url> ~/homelab && cd ~/homelab
cp servers/demo/.env.example servers/demo/.env
# Edit .env with your domain, email, SSH details, etc.

# 2. Deploy
deno task deploy demo

# 3. Start services (or: deno task ssh demo docker compose up -d)
deno task ssh demo
cd ~/homelab/apps && docker compose up -d
```

## Verify

```bash
docker ps                             # Check services
curl -I https://proxy.yourdomain.com  # Test Traefik
curl -I https://status.yourdomain.com # Test Gatus
```

After deployment: Traefik reverse proxy + Watchtower auto-updater + Gatus monitoring running with SSL.

## Add Your First Service

Example: Vaultwarden password manager (already in stacks/)

**1. Add to config.json**:
```json
{
  "stacks": [
    {"name": "traefik"},
    {"name": "watchtower"},
    {"name": "syncthing"},
    {"name": "gatus"},
    {"name": "vaultwarden"}
  ]
}
```

**2. Add any required env vars** to `servers/demo/.env`

**3. Deploy**: `deno task deploy demo`

**4. Access**: `https://passwords.yourdomain.com`

### Creating a New Service

See `stacks/vaultwarden/` for example structure:
- `compose.yml` - Service definition
- `backup.ts` - Backup configuration
- `README.md` - Documentation

Full guide: [Adding Services](adding-services.md)

## Initial Server Provisioning (Optional)

Use Ansible for hardening, firewall, fail2ban:

```bash
pip install ansible
deno task ansible ansible/site.yml demo
```

See [ansible/](../ansible/) for available playbooks.

## Backups

```bash
# Manual backup
cd servers/demo && deno run --env-file=.env -A ../../scripts/backup/+main.ts

# Setup daily cron (on server)
crontab -e
# Add: 0 2 * * * cd ~/homelab/apps && deno task backup
```

Deploy backup cron via Ansible: `deno task ansible ansible/playbooks/backup-cronjob.yml demo`

## Next Steps

- **[Architecture](architecture.md)** - Understand system design
- **[Adding Services](adding-services.md)** - Complete integration guide
- **[Troubleshooting](troubleshooting.md)** - Debug issues
- **Server docs** - See `servers/{server}/README.md` for server-specific notes
- **Service docs** - See `stacks/{service}/README.md` for all available services
