# Pangolin Tunnel Setup — K11 ↔ Cloudlab

## Status: 100% done — end-to-end works via `https://code2.antonshubin.com/` (2026-08-06)

### What's been done (all IaC, committed to branch `feat/pangolin-tunnel`)

1. **DNS** (via CF API, `proxied: false` for direct connection to cloudlab):
   - `code2.antonshubin.com` → `23.88.101.28` (cloudlab, A record)
   - `tunnel-cloud.antonshubin.com` → `23.88.101.28` (cloudlab, A record)
   - Zone ID: `781c29e6e80fcfaecf9500e84ceb8d1a` (from `.env.root`'s `CLOUDFLARE_API_TOKEN`)

2. **Pangolin server stack** deployed on cloudlab:
   - Stack at `stacks/pangolin/compose.yml` (uses **named volumes** `pangolin-config`, `pangolin-traefik`, `pangolin-letsencrypt` — NOT bind mounts, due to userns-remap on cloudlab)
   - Runs: pangolin server + gerbil tunnel client + traefik (in gerbil's netns for SSL)
   - Memory: ~500MB. Cloudlab 4GB total, 1.9GB free after deploy.
   - **Healthcheck fixed** (2026-08-06): was `wget` (not in image) → switched to `node -e` one-liner that `fetch`es `/api/v1/` on 3001. Now actually passes.
   - **`depends_on` fixed** (2026-08-06): all dependents now use `service_started` instead of `service_healthy`. The broken healthcheck had left `hl-gerbil` and `hl-traefik-pangolin` stuck in `Created` state forever.
   - **Port 3002 published** (2026-08-06): `127.0.0.1:3002:3002` on `hl-pangolin`. SSH tunnel now has a target.
   - Deployed via `deno task deploy cloud pangolin` from local main worktree.

3. **Pangolin config** (in `pangolin_pangolin-config` volume at `/app/config/config.yml` on cloudlab):
   ```yaml
   app:
     dashboard_url: https://tunnel-cloud.antonshubin.com
     log_level: info
     save_logs: false
     log_failed_attempts: false
     telemetry: { anonymous_usage: false }
     notifications: { product_updates: false, new_releases: false }
   domains:
     code2:        { base_domain: code2.antonshubin.com,        cert_resolver: letsencrypt }
     tunnelcloud:  { base_domain: tunnel-cloud.antonshubin.com, cert_resolver: letsencrypt }
   gerbil:
     base_endpoint: https://tunnel-cloud.antonshubin.com
   server:
     external_port: 443
     internal_port: 3001
     trust_proxy: 1
     secret: <64-char-hex-generated-via-openssl-rand-hex-32>
     cors: { origins: [https://code2.antonshubin.com, https://tunnel-cloud.antonshubin.com] }
   traefik:
     cert_resolver: letsencrypt
   ```
   To update config: `docker run --rm -v pangolin_pangolin-config:/data --user 0:0 --workdir /data --entrypoint sh fosrl/pangolin:latest -c "cat > /data/config.yml << EOF ... EOF"`

4. **Cloudlab .env** has:
   ```
   PANGOLIN_APP_URL=https://tunnel-cloud.antonshubin.com
   PANGOLIN_MEM_LIMIT=1024M
   PANGOLIN_CPU_LIMIT=1
   PANGOLIN_CONTAINER_NAME=hl-pangolin
   GERBIL_CONTAINER_NAME=hl-gerbil
   TRAEFIK_PANGOLIN_CONTAINER_NAME=hl-traefik-pangolin
   ```

5. **Admin user created** via API:
   - Email: `admin@antonshubin.com`
   - Password: `PangolinTest123!`
   - Session cookie: `p_session_token=ioxwbwevg6uhx6rithjducv2mlrja4bk` (may expire)
   - CSRF token: `x-csrf-protection` (header `x-csrf-token`)
   - API base: `https://tunnel-cloud.antonshubin.com/api/v1/`
   - **Servers bind IPv6 only** (`[::1]`, `::` etc.) — IPv4 (`127.0.0.1`) doesn't work directly inside container. Use IPv6 or host-side Traefik.

6. **Org + 2 domains + 1 resource** (final state):
   - Org: `default` (id: `default`)
   - Domains: `code2` (→ code2.antonshubin.com), `tunnelcloud` (→ tunnel-cloud.antonshubin.com)
   - Resource: `opencode-web` (id: 2) — `fullDomain = code2.antonshubin.com` (recreated via API: `subdomain=null` inside `code2` domain).
   - Site: `k11` (id: 3, type=`newt`) — connected via WireGuard.
   - Target: targetId 2, `siteId=3, ip=127.0.0.1, port=8002, method=http, mode=http`.

7. **PR #120** open: `feat/pangolin-tunnel` → main. Includes compose.yml, README.md, config.json, .env.example, traefik configs, bootstrap.py, main Traefik TCP+SNI passthrough. Latest commits `64c6647` (UI access) and `6a0ebee` (end-to-end).

### How to do the rest via API (if continuing with IaC)

`PUT /api/v1/org/{orgId}/resource` (the actual endpoint, not `/resources`):
- Body: `{ name, subdomain, domainId, mode: "http" }` (the resource schema)
- The auth is on `unauthenticated` router but needs valid session cookie + CSRF

For exit nodes: I tried `/exit-nodes`, `/exit-node`, `/remote-exit-nodes`, `/remote-exit-node` — all 404. The route might only be on internal server (port 3001) which is NOT exposed via Traefik. **To access internal API, SSH tunnel is needed**.

For sites: `PUT /api/v1/org/{orgId}/site` with `{ name, type: "wireguard" or "local", subnet, exitNodeId (if tunneled) }`

For targets: `POST /api/v1/org/{orgId}/resource/{resourceId}/target` with `{ siteId, ip, port, method: "http" }` — endpoint path is a guess, may need source diving.

### Recommended next session: use the UI

**Quickest path to finish (~10 min):**
1. SSH tunnel from this PC to cloudlab:3002 (Next.js UI):
   ```bash
   ssh -f -N -L 3002:127.0.0.1:3002 cloudlab
   # open in browser: http://127.0.0.1:3002
   ```
2. Login with `admin@antonshubin.com` / `PangolinTest123!`
3. UI flow:
   - Delete the broken `opencode-web` resource
   - Recreate resource with subdomain `code2` inside the `code2` domain (or change domain to `antonshubin-root` with subdomain `code2`)
   - Go to **Exit Nodes** → Create one for cloudlab (name: `cloudlab`, address: `https://tunnel-cloud.antonshubin.com`)
   - Go to **Sites** → Create site for K11 (name: `k11`, type: `wireguard` or `local` depending on whether traffic flows via exit node)
   - Go to **Targets** → Add target to the `opencode-web` resource: IP/hostname = `127.0.0.1`, port = `8002`, method = `GET/POST` (or all)
   - **Get gerbil enrollment token** from the site (button in UI)
4. Run gerbil on K11 (this machine):
   ```bash
   docker run -d --name gerbil --restart unless-stopped \
     --network host --cap-add NET_ADMIN --cap-add SYS_MODULE \
     -v /var/lib/gerbil:/var/config \
     fosrl/gerbil:latest \
     --remoteConfig=https://tunnel-cloud.antonshubin.com/api/v1/ \
     --authKey=<gerbil-token-from-pangolin> \
     --generateAndSaveKeyTo=/var/config/key
   ```
5. Test: `curl -skL https://code2.antonshubin.com/`

### How to do the rest via API (if continuing with IaC)

`PUT /api/v1/org/{orgId}/resource` (the actual endpoint, not `/resources`):
- Body: `{ name, subdomain, domainId, mode: "http" }` (the resource schema)
- The auth is on `unauthenticated` router but needs valid session cookie + CSRF

For exit nodes: I tried `/exit-nodes`, `/exit-node`, `/remote-exit-nodes`, `/remote-exit-node` — all 404. The route might only be on internal server (port 3001) which is NOT exposed via Traefik. **To access internal API, SSH tunnel is needed**.

For sites: `PUT /api/v1/org/{orgId}/site` with `{ name, type: "wireguard" or "local", subnet, exitNodeId (if tunneled) }`

For targets: `POST /api/v1/org/{orgId}/resource/{resourceId}/target` with `{ siteId, ip, port, method: "http" }` — endpoint path is a guess, may need source diving.

### Recommended next session: use the UI

**Quickest path to finish (~10 min):**

1. SSH tunnel from this PC to cloudlab:3002 (Next.js UI):
   ```bash
   ssh -f -N -L 3002:127.0.0.1:3002 cloudlab
   # open in browser: http://127.0.0.1:3002
   ```
2. Login with `admin@antonshubin.com` / `PangolinTest123!`
3. UI flow:
   - Delete the broken `opencode-web` resource
   - Recreate resource with subdomain `code2` inside the `code2` domain (or change domain to `antonshubin-root` with subdomain `code2`)
   - Go to **Exit Nodes** → Create one for cloudlab (name: `cloudlab`, address: `https://tunnel-cloud.antonshubin.com`)
   - Go to **Sites** → Create site for K11 (name: `k11`, type: `wireguard` or `local` depending on whether traffic flows via exit node)
   - Go to **Targets** → Add target to the `opencode-web` resource: IP/hostname = `127.0.0.1`, port = `8002`, method = `GET/POST` (or all)
   - **Get gerbil enrollment token** from the site (button in UI)
4. Run gerbil on K11 (this machine):
   ```bash
   docker run -d --name gerbil --restart unless-stopped \
     --network host --cap-add NET_ADMIN --cap-add SYS_MODULE \
     -v /var/lib/gerbil:/var/config \
     fosrl/gerbil:latest \
     --remoteConfig=https://tunnel-cloud.antonshubin.com/api/v1/ \
     --authKey=<gerbil-token-from-pangolin> \
     --generateAndSaveKeyTo=/var/config/key
   ```
5. Test: `curl -skL https://code2.antonshubin.com/`

### OpenCode Web on K11

- **Running** at `http://127.0.0.1:8002` (started via nohup: `nohup /home/spy4x/.opencode/bin/opencode web --hostname 0.0.0.0 --port 8002 > /tmp/opencode.log 2>&1 &`)
- Log: `/tmp/opencode.log` (small, sometimes has "Aborted" warnings — page may need refresh)
- DB: `/home/spy4x/.local/share/opencode/opencode.db` (15.8MB, growing)
- Restart: `pkill -f "opencode web" && nohup /home/spy4x/.opencode/bin/opencode web --hostname 0.0.0.0 --port 8002 > /tmp/opencode.log 2>&1 &`
- **Reachable from anywhere via**: `https://code2.antonshubin.com/` (K11 → newt → WireGuard → cloudlab gerbil → Traefik → target)

### Newt on K11 (running)

- Binary: `/home/spy4x/.local/bin/newt` (v1.15.0)
- Started in background: `nohup newt > /tmp/newt.log 2>&1 &`
- Config: `/home/spy4x/.config/newt-client/config.json` (chmod 600)
- Log: `/tmp/newt.log` — `Started tcp proxy to 127.0.0.1:8002` = working
- To restart cleanly: `pkill -f newt; set -a; source /tmp/pangolin-k11-newt.env; set +a; nohup newt > /tmp/newt.log 2>&1 &`

### Cloud server environment summary

- **Hetzner Germany** (cloudlab), 4GB RAM, 38GB disk (16GB free)
- Currently 2.0GB used, 1.7GB free
- 21+ containers running (pangolin stack added ~500MB)
- After pangolin setup, memory is OK but tight
- Traefik in main config (port 80/443) + Pangolin Traefik (also port 80/443, in gerbil netns)
- Pangolin uses outbound WireGuard tunnels — no inbound ports needed on agents

### Pangolin container behavior notes

- Healthcheck now uses `node -e` fetch (fixed 2026-08-06); should report healthy when API up
- To restart cleanly: `cd ~/cloudlab/apps && docker compose -p pangolin restart pangolin`
- To view logs: `docker logs hl-pangolin` (most recent events)
- To check API health: `curl -k -H "x-csrf-token: x-csrf-protection" https://tunnel-cloud.antonshubin.com/api/v1/auth/initial-setup-complete`
- To SSH tunnel UI: `ssh -f -N -L 3002:127.0.0.1:3002 cloudlab` → open http://127.0.0.1:3002

### Pangolin API quirks learned

- API binds to IPv6 only — IPv4 `127.0.0.1` from inside container doesn't work, use `[::1]`
- All API requests need `X-API-Token: x-csrf-protection` header (or value `x-csrf-protection` in `x-csrf-token` header)
- Login response sets cookie `p_session_token=<token>; HttpOnly`
- Login endpoint: `POST /api/v1/auth/login` with `{email, password}` body
- Create admin: `PUT /api/v1/auth/set-server-admin` with `{setupToken, email, password}`
- Create org: `PUT /api/v1/org/{orgId}` with `{orgId, name, subnet, utilitySubnet}` — orgId must be valid format
- Create domain: auto-created from config.yml on first start (code2, tunnelcloud visible in `/domains` endpoint)
- Create resource: `PUT /api/v1/org/{orgId}/resource` (NOT `/resources` — singular path) with `{name, subdomain, domainId, mode: "http"}`
- List resources: `GET /api/v1/org/{orgId}/resources` (plural here)

### Issues to watch

- `pangolin-traefik` volume is populated manually (`stacks/pangolin/traefik/{traefik_config,dynamic_config}.yml`). After every `deploy cloud pangolin`, the named volume gets emptied by the new container's empty mount. Need a one-shot after.deploy hook to repopulate from `stacks/pangolin/traefik/`. **TODO before this can be considered fully IaC.**
- LE uses TLS-ALPN-01 (port 443, no port 80 plumbing needed). Rate limit: 5 failed authorizations per domain per hour.
- `gerbil.base_endpoint` in `config.yml` must be the **host only** (no protocol), e.g. `tunnel-cloud.antonshubin.com` — the server constructs `${endpoint}:51820` for WireGuard, and a full URL with protocol breaks newt's URL parser. Bug in Pangolin 1.21.1.
- 3-minute Let's Encrypt delay on first run — HTTPS cert takes a moment after first request
- K11 has 96GB RAM unused but Cloudlab only 1.7GB free — be careful with Pangolin resource consumption

### Worktree state

- Worktree: `/home/spy4x/sync/code/homelab` (main, in `feat/pangolin-tunnel` branch)
- PR #120 open: https://github.com/spy4x/homelab/pull/120
- Files added/modified:
  - `stacks/pangolin/compose.yml` — UDP ports on gerbil, container rename
  - `stacks/pangolin/traefik/{traefik_config,dynamic_config}.yml` — Traefik configs
  - `stacks/pangolin/bootstrap.py` — idempotent API driver
  - `stacks/traefik/dynamic/02-pangolin.yml` — main Traefik TCP+SNI passthrough
  - `servers/cloud/.env.example` — container name
  - `servers/cloud/config.json` — already had pangolin
- Latest commit `6a0ebee` pushed: end-to-end working

### OpenCode session to continue

The current opencode-web session (this conversation) is the strategic thread. When this session ends, the next session should:

1. Read this file first
2. Decide: UI path (5-10 min) or API path (20-30 min) for remaining steps
3. After Pangolin works, commit any IaC findings to repo

### Separate task threads (do NOT mix with Pangolin)

- **Syncthing** stopped on homelab; user needs to run rsync for 404GB backups + 474GB camera_videos_heavy (commands provided earlier, still pending)
- **Sasha (Alex) / Michael** relationship — separate from this task
- **K11 → mini PC migration** — separate longer-term plan, not this session

### User environment recap

- Anton: in Vietnam (this PC K11), uses opencode-web here
- Michael: in Singapore, on the homelab server (re-installed Fedora, working with real SanDisk SSD)
- Alex: in Singapore (not in tech — psychology-pattern friend), offered to send drives
- All 3 friends. Anton cares about server autonomy ("I want to be able to maintain it myself without bothering friends")
