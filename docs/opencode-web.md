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
Restart=on-failure
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

Zond target in `stacks/zond/zond.yaml`:
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
