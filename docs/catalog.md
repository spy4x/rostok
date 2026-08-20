# Catalog

The `stacks/` directory. Every entry is a generic, reusable
self-hosted service.

The catalog is what the `rostok` CLI bundles. Users browse it with
`rostok stack list`.

## Categories

### Proxy & TLS

- **traefik** — reverse proxy with auto-TLS via Let's Encrypt
- **cloudflared** — secure Cloudflare tunnel for boxes without a
  public IP

### Auth

- **authelia** — SSO provider (single sign-on for all services)

### Monitoring

- **gatus** — health checks + status page
- **healthchecks** — cron-based health monitoring
- **ntfy** — push notifications / alerting
- **victoria-metrics** — metrics stack (long-term storage + Grafana)

### Data

- **vaultwarden** — password manager (Bitwarden-compatible)
- **immich** — photo/video backup (Google Photos alternative)
- **jellyfin** — media server (Plex alternative)
- **audiobookshelf** — audiobook + podcast server
- **filebrowser** — web-based file manager
- **paperless-ngx** — document scanner + archive
- **stirling-pdf** — PDF manipulation toolkit
- **vscode** — code-server (VS Code in the browser)

### Communication

- **stalwart** — mail server (SMTP, IMAP, JMAP)
- **caldav-mcp** — CalDAV/cardDAV bridge for AI agents
- **email-mcp** — email bridge for AI agents
- **monica-mcp** — CRM bridge for AI agents
- **hugo** — static site generator
- **hedgedoc** — collaborative markdown editor

### Dev

- **gitea** — self-hosted Git (GitHub alternative)
- **woodpecker** — CI/CD pipeline
- **docker-registry** — private Docker image registry
- **playwright** — headless browser for testing

### Productivity

- **home-assistant** — smart-home hub
- **open-webui** — chat UI for local LLMs
- **ollama** — local LLM runner
- **piped** — YouTube/fediverse frontend (Invidious alternative)
- **searxng** — meta-search engine
- **umami** — privacy-friendly analytics
- **usememos** — note-taking (self-hosted)
- **transmission** — BitTorrent client
- **homepage** — dashboard

### Infrastructure

- **syncthing** — file sync between machines
- **wireguard** — VPN
- **ddns** — dynamic DNS updater
- **pangolin** — tunnel broker (alternative to Cloudflare Tunnel)
- **nginx** — reverse proxy (alternative to Traefik)
- **caddy** — reverse proxy (alternative to Traefik)

### Misc

- **adguard** — DNS-level ad-blocker
- **akaunting** — accounting software
- **bulwark** — auth proxy (deprecated; replaced by Authelia)
- **caldiy** — DIY CalDAV server (older setup, replaced by Stalwart)
- **dash** — homelab dashboard
- **librespeed** — LAN speed test
- **offerlens** — price tracker (third-party)
- **plausible** — privacy analytics (alternative to Umami)
- **reitti** — public transport info
- **traggo** — time tracking
- **umami** — see above
- **upwork-triage** — Upwork profile automation
- **zond** — internal health probe bridge (companion to Gatus)

## Listing programmatically

```bash
rostok stack list                     # human-readable
rostok stack list --format json       # machine-readable
rostok stack list --tree              # show intra-catalog deps
```

Tree mode shows dependencies between stacks (e.g., Vaultwarden needs
Traefik for routing). The cross-stack wiring engine itself is a v2
feature (see [`v2-cli.md`](v2-cli.md)).

## Adding to the catalog

See [`adding-services.md`](adding-services.md) for the full author
guide. TL;DR: 4 files per stack, `+meta.ts` declares variables, no
hardcoded secrets.

## Removing from the catalog

Open a PR with `git rm stacks/<name>/`. Provide a brief rationale
(superseded by another stack, abandoned upstream, security issue).
