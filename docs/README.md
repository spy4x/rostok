# Documentation Index

Welcome to the Homelab documentation! Choose the guide that fits your needs:

## Getting Started

### 🚀 [5-Minute Quick Start](get-started-5min.md)
**Perfect for**: First-time setup, new server deployment

Get up and running quickly with base services (Traefik, Watchtower). Includes step-by-step commands and common pitfalls.

**Time**: ~5 minutes  
**Prerequisites**: Linux server, domain name, basic terminal knowledge

---

## Core Documentation

### 🏗️ [Architecture Overview](architecture.md)
**Perfect for**: Understanding how everything fits together

Learn about:
- Three-server topology (home, cloud, offsite)
- Network architecture & data flow
- Service organization & stacks
- Backup strategy
- Security model

**Read this when**: You want to understand the big picture or need to make architecture decisions.

---

### ➕ [Adding Services Guide](adding-services.md)
**Perfect for**: Adding new services to your homelab

Complete step-by-step guide covering:
1. Service definition (shared stacks vs. server-specific local stacks)
2. Environment variable configuration
3. Backup configuration (critical!)
4. Deployment process
5. Monitoring setup
6. Testing & verification

**Includes**:
- Common patterns (databases, authentication, resources)
- Real-world examples
- Best practices
- Troubleshooting

**Read this when**: You want to add Jellyfin, Vaultwarden, or any Docker service.

---

### 🔧 [Troubleshooting Guide](troubleshooting.md)
**Perfect for**: When something goes wrong

Solutions for common issues:
- Deployment errors (import resolution, env vars, port conflicts)
- Backup failures (permissions, repo not found, container issues)
- Traefik & networking (SSL, 404s, CORS)
- Docker Compose (file merging, stack issues)
- System resources (disk space, CPU/memory)

**Includes**:
- Debugging techniques
- Recovery procedures
- Useful commands

**Read this when**: You see an error message or something isn't working as expected.

---

## Specialized Guides

### 💾 [Backup System](../scripts/backup/README.md)
**Technical documentation** for the backup implementation:
- Restic integration
- Configuration format
- Restore procedures
- Adding new services to backup

### ☁️ [Cloud/Email Setup](../servers/cloud/README.md)
**Cloud-specific** documentation:
- Mail server configuration
- DNS records
- Email troubleshooting

### 🐧 [Fedora Networking](../servers/home/README_FEDORA.md)
**Fedora-specific** fixes:
- NetworkManager conflicts
- Docker networking on Fedora

---

## Documentation by Use Case

### "I'm brand new and want to get started"
1. Start with [5-Minute Quick Start](get-started-5min.md)
2. Read [Architecture Overview](architecture.md) to understand your setup
3. Refer to [Troubleshooting](troubleshooting.md) when needed

### "I want to add a new service"
1. Review [Architecture](architecture.md) to understand stacks
2. Follow [Adding Services Guide](adding-services.md) step-by-step
3. Check [Troubleshooting](troubleshooting.md) if deployment fails

### "Something broke, help!"
1. Go directly to [Troubleshooting Guide](troubleshooting.md)
2. Use the table of contents to find your issue
3. Follow debugging techniques if issue not listed

### "I want to understand how backups work"
1. Read backup strategy in [Architecture](architecture.md)
2. Review technical details in [Backup System](../scripts/backup/README.md)
3. Use [Troubleshooting](troubleshooting.md) for backup issues

### "I'm setting up email/cloud services"
1. Follow [Cloud Setup](../servers/cloud/README.md)
2. Refer to [Adding Services](adding-services.md) for service-specific steps
3. Check [Troubleshooting](troubleshooting.md) for common email issues

---

## Quick Reference

### Essential Commands
```bash
# Deploy services
deno task deploy <server>

# SSH to server (or run remote command: deno task ssh <server> <cmd>)
deno task ssh <server>

# Run backup
deno task backup

# Restore from backup
deno task restore

# List all tasks
deno task
```

### Key Configuration Files
- `servers/<server>/.env` - Server environment variables
- `servers/<server>/compose.yml` - Service definitions
- `servers/<server>/configs/backup/*.backup.ts` - Backup configurations
- `servers/<server>/config.json` - Stack selection

### Important Directories on Server
- `~/ssd-2tb/apps/` - Docker services (home server)
- `~/apps/` - Docker services (cloud/offsite)
- `~/.volumes/` - Service data volumes
- `~/sync/backups/` - Restic backup repositories

---

## Contributing to Documentation

Found a mistake or want to improve these docs?

1. Documentation lives in `/docs` folder
2. Use Markdown format
3. Include code examples
4. Add to this index if creating new guides
5. Test all commands before documenting

---

## External Resources

- [Docker Compose Documentation](https://docs.docker.com/compose/)
- [Traefik Documentation](https://doc.traefik.io/traefik/)
- [Restic Documentation](https://restic.readthedocs.io/)
- [Deno Manual](https://deno.land/manual)
- [Ansible Documentation](https://docs.ansible.com/)
