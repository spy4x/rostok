# Homelab Infrastructure

Infrastructure-as-code for self-hosted services across 3 servers (home, cloud, offsite).

**WARNING**: This repo is **public**. Never commit plaintext passwords, secrets, or .env files.
The pre-commit hook auto-encrypts `.env` → `.env.age` using SOPS/age. Decryption key is local-only.

## Architecture

- **Stacks catalog** (`stacks/`): reusable Docker Compose definitions
- **Server configs** (`servers/`): which stacks each server deploys + env vars
- **Deno scripts** (`scripts/`): deploy, backup, SSH helpers
- **Ansible** (`ansible/`): initial server setup, fail2ban, cron jobs
- **All containers use `hl-` prefix** to avoid name conflicts with other projects

## Servers

| Server  | Role                                | Stacks                                                      |
| ------- | ----------------------------------- | ----------------------------------------------------------- |
| Home    | Main server (GPU, media, storage)   | 40 stacks: auth, media, AI, git, CRM, analytics, monitoring |
| Cloud   | Public-facing (mail, edge services) | 10 stacks: mailserver, gatus, healthchecks, ntfy            |
| Offsite | Backup/DR                           | Syncthing, Traefik                                          |

## Key Services

| Service        | URL                          | Auth                |
| -------------- | ---------------------------- | ------------------- |
| Dashboard      | dash.antonshubin.com         | None                |
| Uptime (cloud) | uptime-cloud.antonshubin.com | None                |
| Authentik SSO  | auth.antonshubin.com         | SSO provider        |
| Grafana        | metrics.antonshubin.com      | Basic auth          |
| Passwords      | passwords.antonshubin.com    | Vaultwarden account |
| Email          | (IMAP/SMTP)                  | Mailserver account  |
| AI Chat        | ai.antonshubin.com           | OpenWebUI account   |

Full service list: see `docs/todos.md` (without passwords) or `servers/*/config.json`.

## Quick Start

```bash
# Prerequisites
curl -fsSL https://deno.land/install.sh | sh
# Install Ansible (see docs)

# Clone
git clone https://github.com/spy4x/homelab.git && cd homelab

# Setup env
cp servers/home/.env.example servers/home/.env
# Edit with your domain, SSH params, secrets
nano servers/home/.env

# Deploy
deno task deploy home     # Deploy to home server
deno task ansible ...     # Run Ansible playbooks
```

## Common Tasks

```bash
deno task check           # Lint, format, type-check
deno task deploy <server> # Deploy stacks to server
deno task ssh <server> [cmd]  # SSH into server or run remote command
deno task backup          # Run backup system
deno task env:encrypt     # Encrypt .env files before commit
```

## Secrets Management

- `.env` files are **gitignored** — never committed
- Pre-commit hook auto-encrypts `.env` → `.env.age` via SOPS/age
- Post-checkout hook auto-decrypts `.env.age` → `.env`
- **CREDENTIALS IN THIS README OR DOCS**: Always use "see .env" instead of writing passwords
- If you expose a password: rotate it immediately (update .env + DB + deploy)

## Stack Patterns

Every stack includes:

1. `stacks/{name}/compose.yml` — container with `hl-` prefix, Traefik labels, resource limits
2. `stacks/{name}/backup.ts` — backup config (skip for stateless)
3. Gatus monitoring (cross-server: cloud watches home, home watches cloud)
4. Dashboard entry with health badge

Auth decision:

- **Public**: Reitti, SearXNG, Schedule — no auth middleware
- **Own auth**: Gitea, Vaultwarden, Paperless-ngx, Stirling-PDF — no Traefik auth
- **Basic auth**: Everything else with `middlewares=auth`
- **SSO**: `middlewares=authelia@file` — config-driven, no DB needed

## Status

✅ 50+ services across 3 servers\
✅ Daily automated backups with Restic\
✅ Cross-server health monitoring (Gatus + ntfy alerts)\
✅ GPU passthrough for local LLMs (Ollama + OpenWebUI)\
✅ SSO provider deployed (Authentik — UI setup pending)

See `docs/todos.md` for detailed status and roadmap.
