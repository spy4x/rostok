# Demo Server

This is a minimal example server configuration showing the basic setup required for any new server in the homelab infrastructure.

## Services Included

This demo includes the essential infrastructure services:

- **[Traefik](../../stacks/traefik/README.md)** - Reverse proxy with automatic SSL certificates
- **[Watchtower](../../stacks/watchtower/README.md)** - Automatic container updates
- **[Syncthing](../../stacks/syncthing/README.md)** - File synchronization for backups
- **[Gatus](../../stacks/gatus/README.md)** - Health monitoring and status page

## Quick Setup

### 1. Configure Environment

```bash
# Copy the example environment file
cp servers/demo/.env.example servers/demo/.env

# Edit with your actual values
nano servers/demo/.env
```

**Required changes:**

- `SSH_ADDRESS` - Your server's hostname or IP
- `SSH_PORT` - Your SSH port (if not 22)
- `HOMELAB_USER` - Your SSH username
- `DOMAIN` - Your domain name
- `CONTACT_EMAIL` - Your email for SSL certificates
- `BACKUPS_PASSWORD` - Generate secure password
- `NTFY_TOKEN_BACKUPS` - Token from your ntfy server
- `GATUS_NTFY_TOKEN` - Token from your ntfy server

### 2. Provision Server (Optional)

Use Ansible to set up firewall, fail2ban, and other security:

```bash
deno task ansible ansible/playbooks/initial-setup.yml demo
```

### 3. Deploy

```bash
deno task deploy demo
```

### 4. Verify

```bash
# Check services are running (deno task ssh demo docker ps for non-interactive)
deno task ssh demo
docker ps

# Test access
curl -I https://proxy.yourdomain.com  # Traefik dashboard
curl -I https://status.yourdomain.com  # Gatus status page
```

## File Structure

```
servers/demo/
├── .env.example       # Template configuration
├── config.json        # Which stacks to deploy
├── configs/           # Optional service-specific configs
│   ├── gatus.yml     # Health check endpoints
│   └── backup/       # Non-service backup configs
└── README.md         # This file
```

## Adding More Services

Edit `config.json` to add more services from the [stacks catalog](../../README.md#available-services):

```json
{
  "stacks": [
    { "name": "traefik" },
    { "name": "watchtower" },
    { "name": "syncthing" },
    { "name": "gatus" },
    { "name": "vaultwarden" },
    { "name": "jellyfin" }
  ]
}
```

Then add required environment variables to `.env` and redeploy.

See [Adding Services](../../docs/adding-services.md) for complete guide.

## Next Steps

- Configure [Gatus endpoints](configs/gatus.yml) for monitoring
- Set up [backups](../../scripts/backup/README.md) for services with data
- Review [Architecture](../../docs/architecture.md) to understand the system
- Check [Troubleshooting](../../docs/troubleshooting.md) for common issues

## Notes

- This is a minimal example - adapt to your needs
- All services use Traefik for automatic SSL
- Backups are encrypted and synced via Syncthing
- Watchtower keeps containers updated automatically
- See individual [stack READMEs](../../stacks/) for service-specific docs
