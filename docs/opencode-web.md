# OpenCode Web — Standalone Host Deployment (spy4x)

## Architecture Decision

OpenCode Web runs directly on the host as the **spy4x** user.
No container isolation needed — it needs filesystem access for repos, MCP
servers, and config.

```
┌─────────────────────────────────────────────────────────┐
│ homelab host (Fedora 43)                                │
│                                                         │
│  ┌─────────────────────────────────────────┐            │
│  │ opencode-web (systemd --user)            │            │
│  │ User: spy4x  Port: 0.0.0.0:8002         │            │
│  │ Config: ~/.config/opencode/              │            │
│  │ State: ~/.local/share/opencode/          │            │
│  │ Binary: ~/.opencode/bin/opencode         │            │
│  └──────────────┬──────────────────────────┘            │
│                 │                                       │
│  ┌──────────────▼──────────────────────────┐            │
│  │ Traefik (Docker container on proxy)      │            │
│  │ http://host-gateway:8002  file route     │            │
│  │ Middlewares: authelia@file               │            │
│  └──────────────┬──────────────────────────┘            │
│                 │                                       │
│                 ▼ code.antonshubin.com                   │
└─────────────────────────────────────────────────────────┘
```

## Prerequisites

- opencode binary at `~/.opencode/bin/opencode`
- `~/.config/opencode/opencode.json` configured

## Setup

### 1. Systemd unit (user-scoped)

Create `~/.config/systemd/user/opencode-web.service`:

```ini
[Unit]
Description=OpenCode Web UI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/spy4x
Environment=PATH=/home/spy4x/.opencode/bin:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin

ExecStart=/home/spy4x/.opencode/bin/opencode web --hostname 0.0.0.0 --port 8002
# Use Restart=always (NOT on-failure): TERM-clean shutdowns from a closing SSH
# session are treated as "clean exit" by on-failure and won't restart the service.
# always also covers OOM-kills (signal KILL), stale-port conflicts, and crashes.
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

### 2. Enable linger

```bash
sudo loginctl enable-linger spy4x
```

### 3. Enable and start

```bash
systemctl --user daemon-reload
systemctl --user enable --now opencode-web
systemctl --user status opencode-web
```

### 4. Verify

```bash
curl -s http://127.0.0.1:8002/ | head -5
```

## Traefik Routing

Configured in `servers/home/configs/traefik/dynamic/01-home.yml`:

```yaml
hl-opencode-web:
  rule: "Host(`code.antonshubin.com`)"
  middlewares:
    - authelia
    - robots-deny
  service: hl-opencode-web
  tls:
    certResolver: myresolver

hl-opencode-web:
  loadBalancer:
    servers:
      - url: "http://172.23.0.1:8002"
```

## Monitoring

Zond target in `servers/home/configs/zond.yaml`:
```yaml
- name: opencode-web
  url: http://172.23.0.1:8002/
```

Gatus endpoint on cloud server monitors via `https://probe-home.${DOMAIN}/health/opencode-web`.

## Troubleshooting

```bash
systemctl --user status opencode-web
journalctl --user -u opencode-web -n 50
# Port conflict:
ss -tlnp | grep 8002
```

### Service died and won't auto-restart (Jul 2026 incident)

**Symptom:** `systemctl --user status opencode-web` shows
`Active: inactive (dead)` with `code=killed, signal=TERM` in journal.
Gatus on cloud reports `code.antonshubin.com` down. Zond's per-target probe
returns "unreachable" → cascade of alerts for other home services.

**Root cause:** `Restart=on-failure` treats SIGTERM as a clean exit and does
not restart. Closing an SSH session that hosted the service can trigger TERM
on the user systemd manager (linger must be enabled for the user-scoped
manager to outlive sessions).

**Fix:**

1. Confirm linger is enabled (so the user systemd manager outlives SSH sessions):
   ```bash
   sudo loginctl show-user spy4x | grep Linger    # must be "yes"
   sudo loginctl enable-linger spy4x              # one-time
   ```
2. Change `Restart=on-failure` → `Restart=always` in the unit (see above) so
   OOM-kills and clean TERM also trigger restart.
3. Bring the service back:
   ```bash
   systemctl --user daemon-reload
   systemctl --user start opencode-web
   ```

### Zond `/health` returns 503 intermittently

This is almost always a real probe failure (one target down), not zond itself.
Check which target is failing:

```bash
docker exec hl-zond wget -qO- http://127.0.0.1:8080/health
```

If **all targets show OK** but `/health` still returns 503, zond itself is
over its memory limit and being OOM-killed. As of Jul 2026 the stack uses
`memory: 128M` (was 32M — too low for Deno's ~48MB baseline + buffer).
