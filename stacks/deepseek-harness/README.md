# DeepSeek Harness

AI agent harness with a plugin-based web UI. Powers agents that read,
edit, and run commands inside a chosen workspace — designed around
[DeepSeek](https://deepseek.com) as the default model provider, but
also accepts any OpenAI-compatible endpoint via Settings.

- **Source:** https://github.com/deepseek-ai/deepseek-harness
- **Package:** `@deepseek-ai/dsh` on npm
- **UI:** web at `http://127.0.0.1:3080` by default
- **License:** MIT

## Why host-level

This stack installs dsh as a **user-level systemd service** on the
host, not in a Docker container. Two reasons:

1. `dsh-web-app` (upstream) hard-rejects `--host 0.0.0.0` on the
   CLI for safety — the agent can execute arbitrary code, so the
   upstream authors gate all-interfaces binds. Inside a Docker
   bridge network, the only safe way to reach it from another
   container is to bind `0.0.0.0`, which the gate forbids.
2. On the host there is no bridge network isolation to lose — dsh
   binds `127.0.0.1:3080` (its safe default), and a tiny `socat`
   sidecar (`dsh-proxy.service`) forwards LAN traffic from
   `0.0.0.0:3081` to that loopback bind. No source patches, no
   `--patch` overlays, no bind-mount juggling.

### Why port 3081 for the LAN proxy, not 3080

Linux kernel semantics: binding `0.0.0.0:3080` while anything holds
`127.0.0.1:3080` is a hard conflict (the IPv4 wildcard covers the
loopback range). So the LAN proxy listens on `0.0.0.0:3081` and
forwards to `127.0.0.1:3080` — the offset is documented and stable.
If you'd rather expose on `:3080`, run Traefik on the host (which
can bind any port) and let it do the listening + TLS termination.

For HTTPS from the public internet, run Traefik on the host (rostok
catalog `traefik`) and let it forward to `127.0.0.1:3080` — disable
`dsh-proxy.service` in that case.

## Install (user-local, no sudo required)

```bash
# 1. Install dsh to ~/.local (no /usr/local write access needed)
npm install --prefix ~/.local -g "@deepseek-ai/dsh@${DSH_VERSION:-0.1.1-rc.2}"
~/.local/bin/dsh --version    # sanity check

# 2. Copy systemd units + enable
mkdir -p ~/.config/systemd/user
cp stacks/deepseek-harness/systemd/dsh.service       ~/.config/systemd/user/
cp stacks/deepseek-harness/systemd/dsh-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dsh.service
systemctl --user enable --now dsh-proxy.service    # optional — LAN HTTP

# 3. Make it survive logout (so it runs without an active session)
loginctl enable-linger "$USER"
```

## Access

| Path                | URL                             | Backing             |
| ------------------- | ------------------------------- | ------------------- |
| Localhost (always)  | `http://127.0.0.1:3080`         | `dsh.service`       |
| LAN HTTP (optional) | `http://<host-ip>:3081`         | `dsh-proxy.service` |
| HTTPS (recommended) | `https://code3.antonshubin.com` | Pangolin (cloud)    |

HTTPS goes through Pangolin (cloud) → Newt (this host) → dsh
`127.0.0.1:3080`. The Newt client is already running on this host (the
`mini-pc` site), so no extra client setup is needed — just register
the Pangolin Resource pointing at `127.0.0.1:3080` and Pangolin's HTTP
provider picks it up.

The LAN HTTP proxy (`dsh-proxy.service` on `:3081`) is included for
quick LAN-only access without going through Pangolin. With Pangolin
handling external HTTPS, the proxy is optional — disable it with
`systemctl --user disable --now dsh-proxy.service` if you don't need
LAN HTTP.

### Cloud prerequisites for HTTPS via Pangolin

Already wired (in `servers/cloud/configs/traefik/dynamic/02-pangolin.yml`):

- Cloudflare A record `code3.antonshubin.com` → `23.88.101.28` (orange
  proxy; same shape as `code2`).
- SNI passthrough on cloud's main hl-traefik for `code3.antonshubin.com`
  → `hl-gerbil:443`. File lives in `servers/cloud/configs/traefik/dynamic/`
  (gitignored — `stacks/traefik/before.deploy.ts` merges it into the
  cloud's `stacks/traefik/dynamic/` at deploy time).
- Pangolin Resource `code3` → target `mini-pc` site, `127.0.0.1:3080`,
  mode `http`. Create via Pangolin UI on
  `https://tunnel-cloud.antonshubin.com/`.

## First-run setup

1. Open `http://127.0.0.1:3080` (or the LAN/HTTPS URL).
2. **Settings → Models** — enter a DeepSeek API key (or any
   OpenAI-compatible base URL + key). Save. No restart needed.
3. **Choose workspace** — pick a directory. `dsh` runs as your
   user so any path your user can read/write is fair game.
4. Start a session, send a task. The agent reads/edits files
   inside the chosen workspace and runs commands there.

## Configuration

Variables (informational — host install doesn't use compose env
loading; the wizard records them in `servers/<server>/.env`):

| Key           | Default      | Purpose                                |
| ------------- | ------------ | -------------------------------------- |
| `DSH_VERSION` | `0.1.1-rc.2` | npm dist-tag used in the install line. |

Server-level vars (`DOMAIN`, `TIMEZONE`, `PUID`, `PGID`, `PATH_*`)
are still recorded by the wizard but unused by these systemd units.

## Filesystem layout

```
~/.local/bin/dsh                       # binary (npm install --prefix ~/.local -g)
~/.local/share/dsh/                    # DSH_HOME — backed up via server backup
├── cordis.patch.yml                   # home-level user patch (machine prefs)
├── profiles/                          # per-profile state
│   └── web/                           # web profile
│       ├── agent.cordis.yml           # active agent preset
│       └── node_modules/              # profile-local plugins (cached)
└── .cache/                            # misc dsh cache
```

## Security

- **API key handling** — entered in the Web UI, stored in DSH_HOME.
  Use a scoped DeepSeek key with spend caps. Rotate via
  Settings → Models.
- **Agent permissions** — `dsh` prompts before operations the active
  permission policy treats as approval-required (shell, file writes
  outside the workspace). Default profile is conservative; tighten
  by editing `~/.local/share/dsh/cordis.patch.yml`.
- **Loopback bind** — dsh binds `127.0.0.1:3080` only. LAN access
  goes through `socat` (`dsh-proxy.service`), which is a plain TCP
  forwarder (no TLS). For HTTPS, terminate TLS at Traefik.
- **Telemetry** — `DSH_TELEMETRY_DISABLED=1` in the systemd unit.

## Upgrading

```bash
npm install --prefix ~/.local -g "@deepseek-ai/dsh@<new-version>"
systemctl --user restart dsh.service
```

The new binary lands in `~/.local/bin/dsh`; DSH_HOME state is
preserved across upgrades.

## Troubleshooting

- **`dsh` exits immediately on start** — usually a malformed
  `cordis.patch.yml` in DSH_HOME. Check
  `journalctl --user -u dsh.service -e`.
- **Web UI loads but workspaces are empty** — confirm the
  workspace path is one your user account can read/write (no
  permission surprises; `dsh.service` runs as `$USER`).
- **`dsh-proxy.service` fails to start** — almost always means
  `dsh.service` isn't up yet. `systemctl --user status dsh`
  should be `active`. Port 3080 already in use elsewhere? Check
  `ss -lntp | grep 3080`.
- **403 from DeepSeek API** — bad/missing key in
  Settings → Models. Curl from the host:
  `curl -s https://api.deepseek.com` to confirm egress works.
