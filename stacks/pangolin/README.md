# Pangolin — self-hosted tunnel broker

Self-hosted identity-aware reverse proxy with WireGuard-based tunneled remote
access. Based on [fosrl/pangolin](https://github.com/fosrl/pangolin).

## Architecture

```
User browser
   ↓ HTTPS
Cloudflare DNS
   ↓
[subdomain].antonshubin.com → public IP (cloudlab)
   ↓
main hl-traefik (TCP+SNI passthrough, owns host:80/443)
   ↓
gerbil Traefik (TLS termination, ACME via TLS-ALPN-01)
   ↓
Pangolin server (resource lookup)
   ↓ WireGuard tunnel
Newt client (on target device, e.g. K11)
   ↓ localhost
Service (e.g. opencode-web:8002)
```

## Components

- **pangolin** — server + UI (Next.js) + SQLite DB
- **gerbil** — server-side WireGuard tunnel and relay
- **newt** — remote-site client that exposes target services (outbound tunnel,
  no inbound ports needed on agents)
- **traefik** — HTTPS termination + ACME (runs in gerbil's network namespace)

## Deployment (cloudlab)

- Containers: `hl-pangolin`, `hl-gerbil`, `hl-pangolin-traefik`
- UI: `https://tunnel-cloud.antonshubin.com`; also SSH tunnel:
  `ssh -f -N -L 3002:127.0.0.1:3002 cloudlab` → `http://127.0.0.1:3002/`
- DNS (Cloudflare A records → `23.88.101.28`): `tunnel-cloud.antonshubin.com`,
  `code2.antonshubin.com`
- Firewall: `21820/udp` (relay) + `51820/udp` (WireGuard), declared in
  `servers/cloud/.env` `FIREWALL_PORTS`
- Resource cost: ~500MB total (pangolin ~400MB, gerbil ~50MB, traefik ~50MB).
  Cloudlab has ~1.9GB free → may need to stop other services if OOM.

## Setup (first time)

1. Deploy: `deno task deploy cloud pangolin`
2. Wait for healthcheck (~60s), then read the setup token:
   `ssh cloudlab "docker logs hl-pangolin | grep -A1 'SETUP TOKEN'"`
3. Open `https://tunnel-cloud.antonshubin.com/auth/initial-setup`, enter the
   token, set an admin password (store it outside Git).
4. **Exit Nodes** → Create: name `cloudlab`, address
   `https://tunnel-cloud.antonshubin.com`
5. **Sites** → Create: name `k11`, type **Newt** → save, copy the `id` and
   `secret`.
6. Install pinned Newt on the target device (verify checksum):
   ```bash
   curl -fL -o /tmp/newt \
     https://github.com/fosrl/newt/releases/download/1.15.0/newt_linux_amd64
   printf '%s  %s\n' \
     '25973d7f2666af5a426c84d527c1347ca1bc4a5dc081beec8a81e627bafd9dbd' \
     /tmp/newt | sha256sum --check
   install -Dm755 /tmp/newt ~/.local/bin/newt
   ```
7. Drop the site `id` and `secret` into `newt.env`:
   ```bash
   cat > /etc/newt/newt.env << EOF
   PANGOLIN_ENDPOINT=https://<tunnel-cloud>.<your-domain>
   NEWT_ID=<from step 5>
   NEWT_SECRET=<from step 5>
   EOF
   chmod 600 /etc/newt/newt.env
   ```
8. Install + start the systemd user unit
   (`servers/portable/configs/systemd/user/newt.service` on this host,
   or wherever the credentials live):
   ```bash
   mkdir -p ~/.config/systemd/user
   cp servers/portable/configs/systemd/user/newt.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now newt
   ```
9. **Resources** → Create: subdomain `<subdomain>`, mode `http`, no auth
   (Badger middleware handles auth for the site). **Targets** → Add: site
   `<site-name>`, IP `127.0.0.1`, port `<port>`, method `http`.
10. Open `https://<subdomain>.<your-domain>/` — should serve the service
    on the Newt-connected host.

## Routing via main hl-traefik (SNI passthrough)

Main hl-traefik owns host:80/443 on cloudlab; gerbil Traefik terminates
Pangolin TLS. The TCP+SNI passthrough lives in
`stacks/traefik/dynamic/02-pangolin.yml`. Each Pangolin-managed hostname needs
BOTH:

- an SNI router in `02-pangolin.yml`: `HostSNI(...)` → service
  `pangolin-gerbil`, `tls.passthrough: true`
- a Resource in the Pangolin UI

## Re-init (fresh Pangolin)

```bash
ssh cloudlab "cd ~/cloudlab/apps && docker compose -p pangolin down --volumes"
# optional: drop LE cert volumes to force re-issuance (hits rate limits)
ssh cloudlab "docker volume rm pangolin_pangolin-letsencrypt"
deno task deploy cloud pangolin
```

Then follow the dashboard from step 3.

## Known gotchas

- **newt 1.15.0 ↔ pangolin 1.21.1 protocol mismatch**: server returns
  `newt/wg/receive-config`, newt expects `newt/wg/connect`. Workaround:
  `gerbil.base_endpoint` in pangolin's `config.yml` must be host-only (no
  `https://` prefix) — the server then builds `endpoint: ${host}:51820`, which
  newt parses correctly. Keep newt pinned at 1.15.0 and pangolin at 1.21.1
  until upstream fixes this.
- **LE cert issuance**: TLS-ALPN-01 rides on port 443 via the SNI passthrough —
  no port 80 plumbing needed, but the hostname must be reachable through main
  hl-traefik first.
- **traefik configs**: `./traefik` is bind-mounted into `hl-pangolin-traefik`,
  repo edits apply on next deploy. Pangolin-managed routes come from the HTTP
  provider (`http://pangolin:3001/api/v1/traefik-config`).
- **volumes**: `pangolin-config` is shared — pangolin uses `/app/config`,
  gerbil writes its key to `/var/config`. Needs backup/restore support (see
  TODO).

## OpenCode Web on K11 (tunneled example)

- Running at `http://127.0.0.1:8002` (nohup):
  `nohup /home/spy4x/.opencode/bin/opencode web --hostname 0.0.0.0 --port 8002 > /tmp/opencode.log 2>&1 &`
- Log: `/tmp/opencode.log`; DB: `/home/spy4x/.local/share/opencode/opencode.db`
- Restart: `pkill -f "opencode web"` then rerun the nohup command above.

## TODO

- [ ] Add a reproducible Newt service definition for portable hosts.
- [ ] Add backup and restore support for the `pangolin-config` named volume.
