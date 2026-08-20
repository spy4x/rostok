# Catalog

The `stacks/` directory. Every entry is a generic, reusable
self-hosted service.

The catalog is what the `rostok` CLI bundles. Users browse it with
`rostok stack list`.

## Categories

### Proxy & TLS

- [traefik](../../stacks/traefik/README.md) — reverse proxy with
  auto-TLS via Let's Encrypt
- [cloudflared](../../stacks/cloudflared/README.md) — secure Cloudflare
  tunnel for boxes without a public IP
- [nginx](../../stacks/nginx/README.md) — reverse proxy (alternative
  to Traefik)
- [pangolin](../../stacks/pangolin/README.md) — tunnel broker
  (alternative to Cloudflare Tunnel)

### Auth

- [authelia](../../stacks/authelia/README.md) — SSO provider (single
  sign-on for all services)

### Monitoring

- [gatus](../../stacks/gatus/README.md) — health checks + status page
- [healthchecks](../../stacks/healthchecks/README.md) — cron-based
  health monitoring
- [ntfy](../../stacks/ntfy/README.md) — push notifications / alerting
- [victoria-metrics](../../stacks/victoria-metrics/README.md) — metrics
  stack (long-term storage + Grafana)
- [watchtower](../../stacks/watchtower/README.md) — automatic container
  updates
- [zond](../../stacks/zond/README.md) — internal health probe bridge
  (companion to Gatus)

### Data

- [vaultwarden](../../stacks/vaultwarden/README.md) — password manager
  (Bitwarden-compatible)
- [immich](../../stacks/immich/README.md) — photo/video backup (Google
  Photos alternative)
- [jellyfin](../../stacks/jellyfin/README.md) — media server (Plex
  alternative)
- [audiobookshelf](../../stacks/audiobookshelf/README.md) — audiobook +
  podcast server
- [filebrowser](../../stacks/filebrowser/README.md) — web-based file
  manager
- [metube](../../stacks/metube/README.md) — YouTube/bandcamp downloader

### Communication

- [stalwart](../../stacks/stalwart/README.md) — mail server (SMTP,
  IMAP, JMAP)
- [bulwark](../../stacks/bulwark/README.md) — JMAP webmail UI (frontend
  for Stalwart)
- [caldav-mcp](../../stacks/caldav-mcp/README.md) — CalDAV/cardDAV
  bridge for AI agents
- [email-mcp](../../stacks/email-mcp/README.md) — email bridge for AI
  agents

### Dev

- [gitea](../../stacks/gitea/README.md) — self-hosted Git (GitHub
  alternative)
- [woodpecker](../../stacks/woodpecker/README.md) — CI/CD pipeline
- [docker-registry](../../stacks/docker-registry/README.md) — private
  Docker image registry
- [docker-sock-proxy](../../stacks/docker-sock-proxy/README.md) —
  restricted Docker socket proxy
- [playwright](../../stacks/playwright/README.md) — headless browser
  for testing
- [opencode-web](../../stacks/opencode-web/README.md) — AI coding
  assistant (web)
- [github-mcp](../../stacks/github-mcp/README.md) — GitHub bridge for
  AI agents
- [google-maps-mcp](../../stacks/google-maps-mcp/README.md) — Google
  Maps bridge for AI agents

### Productivity

- [home-assistant](../../stacks/home-assistant/README.md) — smart-home
  hub
- [open-webui](../../stacks/open-webui/README.md) — chat UI for local
  LLMs
- [ollama](../../stacks/ollama/README.md) — local LLM runner
- [piped](../../stacks/piped/README.md) — YouTube/fediverse frontend
  (Invidious alternative)
- [searxng](../../stacks/searxng/README.md) — meta-search engine
- [umami](../../stacks/umami/README.md) — privacy-friendly analytics
- [plausible](../../stacks/plausible/README.md) — privacy analytics
  (alternative to Umami)
- [usememos](../../stacks/usememos/README.md) — note-taking
  (self-hosted)
- [transmission](../../stacks/transmission/README.md) — BitTorrent
  client
- [mirotalk](../../stacks/mirotalk/README.md) — WebRTC video calls
- [omni-tools](../../stacks/omni-tools/README.md) — web developer
  toolbox

### Infrastructure

- [syncthing](../../stacks/syncthing/README.md) — file sync between
  machines
- [wireguard](../../stacks/wireguard/README.md) — VPN

### Misc

- [adguard](../../stacks/adguard/README.md) — DNS-level ad-blocker
- [akaunting](../../stacks/akaunting/README.md) — accounting software
- [caldiy](../../stacks/caldiy/README.md) — DIY CalDAV server (older
  setup, replaced by Stalwart)
- [librespeed](../../stacks/librespeed/README.md) — LAN speed test
- [traggo](../../stacks/traggo/README.md) — time tracking

## Listing programmatically

```bash
rostok stack list                     # human-readable
rostok stack list --format json       # machine-readable
rostok stack list --tree              # show intra-catalog deps
```

Tree mode shows dependencies between stacks (e.g., Vaultwarden needs
Traefik for routing). The cross-stack wiring engine itself is a v2
feature (see [`v2-cli.md`](../design/v2-cli.md)).

## Adding to the catalog

See [`adding-services.md`](../contributing/adding-services.md) for the
full author guide. TL;DR: 4 files per stack, `+meta.ts` declares
variables, no hardcoded secrets.

## Removing from the catalog

Open a PR with `git rm stacks/<name>/`. Provide a brief rationale
(superseded by another stack, abandoned upstream, security issue).