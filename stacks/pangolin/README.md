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
Gerbil client (on target device)
   ↓ localhost
Service (e.g., opencode-web:8002)
```

## Components

- **pangolin** — server + UI (Next.js) + SQLite DB
- **gerbil** — WireGuard tunnel client (runs locally + on every target device)
- **traefik** — HTTPS termination + ACME (runs in gerbil's network namespace)

## Resource cost (cloudlab, 4GB server)

- pangolin: ~400MB RAM
- gerbil: ~50MB
- traefik: ~50MB
- **Total: ~500MB** — fits comfortably in cloudlab's 1.9GB free

## Setup (first time)

1. Deploy: `deno task deploy cloud pangolin`
2. Wait for container healthcheck (~60s)
3. Access UI: `http://<server-ip>:3001` (or via Traefik at `https://code2.antonshubin.com` after Pangolin routes it)
4. Initial setup via UI:
   - Create admin user
   - Create a Resource (e.g., `code2.antonshubin.com` → protocol HTTP, target `http://localhost:8002`)
   - Pangolin generates a Gerbil config (org_id, node_id, secret)
5. On the target device (e.g., K11), run Gerbil with the config:
   ```bash
   docker run -d --name gerbil \
     --network host --cap-add NET_ADMIN --cap-add SYS_MODULE \
     -v /var/lib/gerbil:/var/config \
     fosrl/gerbil:latest \
     --remoteConfig=https://code2.antonshubin.com/api/v1/ \
     --authKey=<secret-from-pangolin-ui> \
     --generateAndSaveKeyTo=/var/config/key
   ```
6. Open `https://code2.antonshubin.com` from any browser → connects via tunnel to target service.

## Memory budget for cloud (4GB server)

This stack consumes ~500MB. After deployment + other services (~1.8GB used), expect ~2.3GB total. Cloudlab has 1.9GB free → may need to stop other services temporarily if OOM.

## Notes

- Pangolin uses outbound WireGuard tunnels — no inbound ports needed on agents
- ACME/Let's Encrypt for HTTPS (automatic via Traefik)
- Identity-aware: supports OIDC, email/password, etc.
- For this initial deploy, only Pangolin server + gerbil-on-server are enabled. Agent gerbils on remote devices (K11) are configured separately with auth keys.

## TODO

- [ ] Add `servers/cloud/config.json` entry
- [ ] Add `servers/cloud/.env.example` entries (PANGOLIN_APP_URL, etc.)
- [ ] Gerbil agent stack for K11 / home server deployment