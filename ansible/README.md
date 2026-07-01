# Ansible Directory

This directory contains Ansible playbooks for automating homelab server setup and maintenance.

## 🔄 Dynamic Inventory

**IMPORTANT**: This setup uses a **dynamic inventory script** (`scripts/ansible/inventory.ts`) that generates the inventory on-the-fly from your server configurations.

### How It Works

When you run `deno task ansible`, it:

1. Loads environment variables from `.env.root` and `servers/{server}/.env`
2. Calls `ansible-playbook` with `-i scripts/ansible/inventory.ts`
3. The inventory script reads `servers/{server}/config.json` and outputs JSON inventory
4. Ansible playbooks access environment variables using `{{ lookup('env', 'VAR_NAME') }}`

### Benefits

- **No generated files** - inventory is created dynamically each time
- **Single source of truth** - all config in `.env` and `config.json` files
- **Automatic sync** - inventory always matches current configuration
- **Environment variables** - playbooks access vars directly from shell environment

## 📚 Available Playbooks

All playbooks are in the `playbooks/` directory:

### Initial Setup

- `initial-setup.yml` - Fresh server setup (Docker, Deno, system config)
- `ssh-hardening.yml` - Secure SSH configuration

### Maintenance

- `maintenance.yml` - System updates, log rotation, cleanup
- `backup-cronjob.yml` - Setup automated backups
- `fail2ban.yml` - Configure fail2ban for Docker containers
- `mailserver-certs-renewal.yml` - Setup automatic SSL certificate renewal for mailserver

### Monitoring

- `monitoring.yml` - Container health checks and alerting
- `smart-monitoring.yml` - Hard drive SMART monitoring

### Specific Services

- `radicale-setup.yml` — **removed** CalDAV migrated to Stalwart on cloud
- `fix-raspberry-pi.yml` - Fix Raspberry Pi read-only boot partition

## 🚀 Usage

### Run a Playbook

```bash
deno task ansible <playbook> <target>
```

**Examples**:

```bash
# Initial setup for home server
deno task ansible ansible/playbooks/initial-setup.yml home

# Setup backups on offsite server
deno task ansible ansible/playbooks/backup-cronjob.yml offsite

# Run maintenance on all servers
deno task ansible ansible/playbooks/maintenance.yml all

# Setup monitoring on cloud server
deno task ansible ansible/playbooks/monitoring.yml cloud
```

### Environment Variables

The `deno task ansible` command automatically loads and merges environment variables from:

1. System environment
2. `.env.root` - Shared configuration
3. `servers/{target}/.env` - Server-specific configuration

## 📝 Adding a New Server

1. **Create server directory**:
   ```bash
   mkdir -p servers/newserver/configs/backup
   ```

2. **Copy and configure `.env`**:
   ```bash
   cp servers/home/.env.example servers/newserver/.env
   # Edit servers/newserver/.env with your values
   ```

3. **Create `config.json`**:
   ```json
   {
     "sharedStacks": ["traefik", "watchtower", "syncthing"],
     "backup": {
       "cronHour": 2,
       "cronMinute": 30
     },
     "fail2ban": {
       "jails": []
     }
   }
   ```

4. **Run initial setup** (inventory is generated automatically):
   ```bash
   deno task ansible ansible/playbooks/initial-setup.yml newserver
   ```

That's it! The dynamic inventory script will automatically discover and configure the new server.

## 🔧 Configuration

### Shared Configuration (`.env.root`)

Variables shared across all servers:

- NTFY tokens and URLs for notifications
- SSH ports for each server
- SMART monitoring thresholds
- Basic auth credentials

### Server-Specific Configuration (`servers/{server}/.env`)

Variables specific to each server:

- Server name and domain
- SSH connection details
- File paths (apps, media, backups)
- Service-specific settings

### Server Metadata (`servers/{server}/config.json`)

Structured configuration for:

- Shared stacks to deploy
- Backup schedule (cronHour, cronMinute)
- Fail2ban jails and their settings

## 📖 Documentation

- [Ansible Refactoring Summary](../docs/ansible-refactoring.md) - Details of the recent refactoring
- [Architecture](../docs/architecture.md) - Overall homelab architecture
- [Troubleshooting](../docs/troubleshooting.md) - Common issues and solutions

## 🔍 Inventory Structure

The dynamic inventory script (`scripts/ansible/inventory.ts`) generates JSON inventory like:

```json
{
  "all": {
    "children": {
      "homelab_servers": {
        "hosts": {
          "home": {
            "ansible_host": "spy4x-server-mini-pc-external",
            "ansible_user": "spy4x",
            "ssh_port": "{{ lookup('env', 'SSH_PORT') }}",
            "ntfy_url_hardware": "{{ lookup('env', 'NTFY_URL_HARDWARE') }}"
            // ... more variables with env lookups
          }
        },
        "vars": {
          "ansible_python_interpreter": "/usr/bin/python3",
          "homelab_user": "spy4x"
        }
      }
    }
  }
}
```

Variables using `{{ lookup('env', 'VAR') }}` are resolved from the environment at runtime.

## 🎯 Best Practices

1. **Keep configs in version control** - `.env.example` and `config.json` files are committed
2. **Test playbooks** on a single server before running on `all`
3. **Use version control** for all configuration changes
4. **Document custom playbooks** if you add new ones
5. **Keep secrets secure** - never commit `.env` files (they're gitignored)

## 🛟 Troubleshooting

### Inventory script not executable

```bash
chmod +x scripts/ansible/inventory.ts
```

### Variables not loaded

```bash
# Check that .env.root and servers/{server}/.env exist
ls -la .env.root servers/*/.env

# Test the inventory script directly
./scripts/ansible/inventory.ts | jq .
```

### Environment variables not resolved

```bash
# Variables are loaded by scripts/ansible/+main.ts from:
# 1. .env.root (shared vars)
# 2. servers/{server}/.env (server-specific vars)
# Check these files have the required variables
```

### SSH connection issues

```bash
# Test SSH connection manually
ssh -p <SSH_PORT> <ansible_user>@<ansible_host>

# Check SSH config
cat ~/.ssh/config
```

## 📚 Further Reading

- [Ansible Documentation](https://docs.ansible.com/)
- [Ansible Best Practices](https://docs.ansible.com/ansible/latest/user_guide/playbooks_best_practices.html)
- [Homelab Architecture](../docs/architecture.md)
