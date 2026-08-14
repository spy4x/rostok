# Pangolin + Gerbil

Self-hosted identity-aware reverse proxy with WireGuard-based tunneled remote access. Based on [fosrl/pangolin](https://github.com/fosrl/pangolin).

## Architecture

```
User browser
   ↓ HTTPS
Cloudflare DNS (or direct)
   ↓
[code2.antonshubin.com] → public IP (this Pangolin server)
   ↓
Traefik (HTTPS termination, ACME)
   ↓
Pangolin server (resource lookup)
   ↓ WireGuard tunnel
Newt client (on target device)
   ↓ localhost
Service (e.g., opencode-web:8002)
```

## Components

- **pangolin** — server + UI (Next.js) + SQLite DB
- **gerbil** — server-side WireGuard tunnel and relay
- **newt** — remote-site client that exposes target services
- **traefik** — HTTPS termination + ACME (runs in gerbil's network namespace)

## Resource cost (cloudlab, 4GB server)

- pangolin: ~400MB RAM
- gerbil: ~50MB
- traefik: ~50MB
- **Total: ~500MB** — fits comfortably in cloudlab's 1.9GB free

## Setup (first time)

1. Deploy: `deno task deploy cloud pangolin`
2. Wait for container healthcheck (~60s)
3. Access UI through an SSH tunnel to `127.0.0.1:3002` or at
   `https://tunnel-cloud.antonshubin.com`.
4. Complete setup via UI:
   - Create admin user
   - Create a Resource (e.g., `code2.antonshubin.com` → protocol HTTP, target `http://localhost:8002`)
   - Create a Newt site and copy its ID and secret.
5. Install pinned Newt binary and service on target device. Follow
   [`docs/active-tasks/pangolin-tunnel-k11.md`](../../docs/active-tasks/pangolin-tunnel-k11.md).
6. Open `https://code2.antonshubin.com` from any browser. Traffic reaches target
   service through Newt and WireGuard.

## Memory budget for cloud (4GB server)

This stack consumes ~500MB. After deployment + other services (~1.8GB used), expect ~2.3GB total. Cloudlab has 1.9GB free → may need to stop other services temporarily if OOM.

## Notes

- Newt initiates outbound tunnel; no inbound ports needed on remote sites
- ACME/Let's Encrypt for HTTPS (automatic via Traefik)
- Identity-aware: supports OIDC, email/password, etc.
- Pangolin and server-side Gerbil run on cloudlab. Newt runs separately on remote sites.

## TODO

- [ ] Add a reproducible Newt service definition for portable hosts.
- [ ] Add backup and restore support for the `pangolin-config` named volume.
