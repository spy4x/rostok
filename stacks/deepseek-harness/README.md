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
   binds `127.0.0.1:3080` (its safe default). No source patches, no
   `--patch` overlays, no bind-mount juggling.

For HTTPS from the public internet, run Traefik on the host (rostok
catalog `traefik`) or terminate TLS elsewhere (Pangolin on cloud, a
LAN nginx, etc.) and forward to `127.0.0.1:3080`.

## Install (user-local, no sudo required)

```bash
# 1. Install dsh to ~/.local (no /usr/local write access needed)
npm install --prefix ~/.local -g "@deepseek-ai/dsh@${DSH_VERSION:-0.1.1-rc.2}"
~/.local/bin/dsh --version    # sanity check

# 2. Copy systemd unit + enable
mkdir -p ~/.config/systemd/user
cp stacks/deepseek-harness/systemd/dsh.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now dsh.service

# 3. Make it survive logout (so it runs without an active session)
loginctl enable-linger "$USER"
```

## Access

| Path                | URL                                 | Backing          |
| ------------------- | ----------------------------------- | ---------------- |
| Localhost (always)  | `http://127.0.0.1:3080`             | `dsh.service`    |
| HTTPS (recommended) | `https://<hostname>` (set up below) | Pangolin (cloud) |

HTTPS goes through Pangolin (cloud) → Newt (this host) → dsh
`127.0.0.1:3080`. Pick a hostname you own (e.g. `<dsh>.<your-domain>`)
and an unused Newt site, then register the Pangolin
Resource pointing at `127.0.0.1:3080` so the HTTP provider picks it up.

### Cloud prerequisites for HTTPS via Pangolin

The shape (placeholders — replace `<...>` with your own values):

- **DNS** — Cloudflare A record `<dsh>.<your-domain>` → cloud server IP.
  Cloud proxy off (grey cloud) is fine; Pangolin terminates TLS.
- **SNI passthrough** — `servers/cloud/configs/traefik/dynamic/<dsh>-pangolin.yml`
  on the cloud's main hl-traefik, routes `HostSNI(<dsh>.<your-domain>)`
  → `hl-gerbil:443` with `tls.passthrough: true`. Lives at
  `servers/cloud/configs/traefik/dynamic/` (gitignored — the
  `stacks/traefik/before.deploy.ts` hook merges it into the cloud
  server's `stacks/traefik/dynamic/` at deploy time).
- **Pangolin Resource** — name `<dsh>`, target the Newt site,
  destination `127.0.0.1:3080`, mode `http`. Create in Pangolin UI on
  `<tunnel-cloud>.<your-domain>` (your Pangolin dashboard URL).
- **Host/Origin header rewrite on hl-pangolin-traefik** — dsh's
  browser-trust fence rejects privileged methods
  (`host.pickDirectory`, `settings.*`, `credentials.*`,
  `llm.discoverModels`) unless `Host` AND `Origin` equal the bind
  authority (loopback-only by design — see
  `node_modules/@deepseek-ai/dsh-client-connection/lib/index.js`
  `PRIVILEGED_METHODS`). The fix is a Traefik middleware that rewrites
  those headers to `127.0.0.1:3080` for `<dsh>.<your-domain>`
  requests. Lives at `servers/cloud/configs/pangolin/traefik/dynamic_config.yml`
  in the deploy tree, not in the Pangolin catalog stack (per-host
  config). After editing, `ssh <cloud> touch
  ~/apps/rostok/configs/pangolin/traefik/dynamic_config.yml` triggers
  a reload.

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
- **Loopback bind** — dsh binds `127.0.0.1:3080` only. For HTTPS,
  terminate TLS at a reverse proxy on the host (Traefik catalog) or
  forward through a tunnel broker (Pangolin catalog).
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
- **403 from DeepSeek API** — bad/missing key in
  Settings → Models. Curl from the host:
  `curl -s https://api.deepseek.com` to confirm egress works.
