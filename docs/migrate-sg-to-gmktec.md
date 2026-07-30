# Migrate SG Gaming PC → GMKTec K11 Mini PC

**Status:** Plan only — no migration executed yet. Document lives in
`docs/migrate-sg-to-gmktec.md` and is the canonical reference for the cutover.

## 0. Context

The Singapore (SG) home server — an old gaming PC running Fedora 40 with a
dead SATA SSD — has been offline for a week. The friend who lives in that
apartment cannot recover it, and the box is unreachable. This plan retires
the SG server and stands up the home server role on a portable GMKTec K11
mini PC that travels with you. **All SG data is restored from existing
Restic snapshots already replicated to `cloud` and `offsite` via Syncthing.**
There is nothing left to image off the SG host — that path is closed.

| Item | SG server (today, dead) | GMKTec K11 (target) |
|---|---|---|
| OS | Fedora 40 (was) | Fedora KDE latest |
| CPU | Old gaming-PC class | AMD Ryzen 9 8945HS, 8C/16T, 4.0–5.2 GHz, TDP 35–54W |
| GPU | NVIDIA (required for CUDA stacks) | Radeon 780M iGPU only (RDNA 3, **no CUDA**) |
| RAM | unknown (was) | 96 GB DDR5-5600 |
| Storage | Dying SATA SSD + externals | 4 TB NVMe (PCIe 4.0 x4, 2× M.2 slots) |
| Network | Static residential IP `165.173.1.38` | No static IP — moves with you |
| Form factor | ATX tower, fans, dust | 132 × 125 × 58 mm, 120W brick |
| Uptime expectation | Residential (periodic power loss) | Portable (transport vibration, power cuts, hotel Wi-Fi) |
| Maintenance | Remote via friend | Hands-on, wherever the box sits |

## 1. Why this is the right move (TL;DR)

- You can fix hardware/OS problems yourself wherever the GMKTec is. The SG
  dependency on a remote pair of hands is the actual blocker today, not the
  hardware specs.
- 96 GB DDR5 + 8C/16T Zen4 + 4 TB NVMe beats the SG box on every metric that
  matters for these stacks: RAM (plenty of headroom for Immich ML,
  Paperless), storage speed (NVMe vs dying SATA), and idle power (~35–54W CPU
  TDP, vs full gaming-PC PSU spinning).
- Offsite backup replication (Syncthing) already exists — if the GMKTec dies,
  data lives on `cloud` and `offsite`.

## 2. Why GMKTec K11 is *good enough* (capability check)

Workload sizing for the 46 home stacks (Ollama already removed from
`servers/home/config.json`). Memory ceiling per resource limits in
`servers/home/config.json` + compose `deploy.resources.limits`:

| Bucket | Stacks | Worst-case RAM |
|---|---|---|
| Immich (server + ML + Postgres + Valkey) | 1 stack, 4 services | 8 + 4 + 8 + 2 = 22 GB |
| Jellyfin | 1 | 8 GB |
| Paperless-ngx (+ Postgres + Redis + Gotenberg + Tika) | 1 stack, multi-service | ~6 GB |
| VictoriaMetrics + VictoriaLogs + Grafana + Prometheus exporters | 5 services | ~1 GB |
| Everything else (Vaultwarden, Gitea, Authelia, Open WebUI, Immich Kiosk, Cal.com, Monica, AdGuard, Syncthing, Traefik, WireGuard, …) | ~35 stacks | ~6–10 GB |
| OS + Docker + filesystem caches | — | 2–4 GB |

**Estimate:** comfortable headroom around 40–50 GB used out of 96 GB. With
Ollama gone, the big memory consumer left is Immich ML (~4 GB) and Jellyfin
(~8 GB only when actively transcoding). RAM is no longer a constraint.

CPU: 8C/16T Zen4 at 5.2 GHz boost is fine for the actual workloads (most
containers are memory-bound, not CPU-bound). CPU contention only matters if
Jellyfin transcodes 4K + Immich ML runs CLIP/face recognition concurrently.
Power profile is laptop-class — the box will run 24/7 without roasting.

GPU: **Radeon 780M only, no CUDA.** This breaks the NVIDIA-dependent stacks.
Stacks needing rework (Ollama already removed from config, so drop from
this list too):

- ~~`stacks/ollama/compose.yml` lines 27–30~~ — gone, no action needed
- `stacks/jellyfin/compose.yml` lines 31–35: `driver: nvidia` — must switch
  to VAAPI (`/dev/dri/renderD128`) or CPU-only
- `stacks/paperless-ngx/compose.yml` lines 75, 127: `driver: nvidia`
  (Tesseract/Gotenberg) — switch to CPU or skip
- `stacks/immich/hwaccel.transcoding.yml` line 17: NVENC — switch to VAAPI
  via `/dev/dri/renderD128`
- `stacks/immich/hwaccel.ml.yml` line 31: CUDA — switch to OpenVINO/CPU
  (`immich-machine-learning:release-openvino` tag, no GPU runtime needed)
- `stacks/immich/compose.yml` line 75: `runtime: nvidia` — drop the runtime
  and the `-cuda` image tag

The K11 has an **OCuLink port (PCIe Gen4 x4)** for an external GPU enclosure.
This is the escape hatch if you ever need NVIDIA compute, but it adds
hardware, hot-plug risk during travel, and power draw. Defer.

**Bottom line:** the K11 handles everything if you accept (a) slower ML
inference on CPU/VAAPI vs CUDA, (b) no local LLM acceleration beyond what
ROCm gives you for free, (c) Jellyfin transcoding limited to ~2–3 1080p
streams concurrently on VAAPI. None of these are blockers for a single-user
homelab.

## 3. Pangolin evaluation

Pangolin is the right tool for "I have a server behind a moving NAT, no
static IP, no port forwarding." It is a self-hostable WireGuard-based remote
access platform: server on `cloud` (Hetzner), client (the `newt` connector)
on the GMKTec.

Reference: https://pangolin.net/ , https://docs.pangolin.net/

### How it fits this stack

Today the SG server is the network edge for `*.antonshubin.com`:

```
Internet → Cloudflare (proxied) → 165.173.1.38:443 (Traefik) → containers
                ├── Traefik: ACME HTTP-01 challenge, TLS termination
                ├── Let's Encrypt: cert issuance for the wildcard
                └── Authelia forward-auth on protected domains
```

With Pangolin, the edge becomes:

```
Internet → Pangolin server (cloud) → WireGuard tunnel → newt (GMKTec)
                                                        └── Traefik still runs locally
                                                            ├── still terminates TLS
                                                            ├── still issues LE certs (HTTP-01 still works through Pangolin? verify)
                                                            └── Authelia still in front
```

Pangolin's resources let you define per-domain targets:

- **Public resources** (HTTP/HTTPS reverse proxy): for every domain that
  currently resolves via Cloudflare to `165.173.1.38`, create a Pangolin
  resource pointing at the corresponding Traefik upstream (or at Traefik
  itself on a non-standard port and let Traefik route by `Host` header).
- **Private resources** (zero-trust): for SSH, internal admin UIs (Woodpecker,
  VictoriaMetrics raw, etc.), use Pangolin's client + port forwarding instead
  of WireGuard.
- **Browser-based SSH/RDP/VNC**: not relevant here — you don't expose those.

### Pros (vs SG setup)

1. **No static IP needed.** GMKTec can be anywhere with outbound internet.
   New IP, new hotel Wi-Fi, new country — nothing to reconfigure.
2. **No port forwarding.** Hotel/Airbnb NAT, captive portals, ISP CGNAT — all
   stop being a problem.
3. **No Cloudflare proxy dependency.** Pangolin handles TLS at the edge; you
   can keep Cloudflare DNS-only for records you don't proxy, or drop it
   entirely for non-mail records. (Keep Cloudflare DNS for mail.)
4. **Zero-trust auth.** Pangolin ships identity-aware access — the existing
   Authelia layer is technically redundant for browser-based access, but
   keep it for defense-in-depth (per `docs/auth.md`).
5. **NAT-traversal built in.** Like Cloudflare Tunnel but self-hosted; same
   "no open ports" posture, more control over certs.
6. **Cloud-side can stay Hetzner.** You already pay for it. Adding Pangolin
   to `servers/cloud/config.json` is the same Ansible + deploy pattern.
7. **WireGuard-based.** Audited, fast, well-understood. No new crypto surface.

### Cons (vs SG setup)

1. **Extra hop = added latency and one more failure point.** Every request
   goes Cloud → Pangolin → GMKTec → container. Add ~10–50ms per request.
   Probably imperceptible for browser traffic; visible on SSH/streaming.
2. **Pangolin server outage = home server unreachable.** Single point of
   failure for inbound traffic. The cloud server already has 99.99% SLA so
   this is acceptable, but it's an explicit new dependency. Mitigation:
   run Pangolin HA across two VMs, or keep WireGuard on GMKTec as a
   parallel access path for emergencies.
3. **ACME HTTP-01 challenge over Pangolin.** Let's Encrypt needs to hit port
   80 of your domain to issue certs. This works *only* if Pangolin's HTTP
   resource exposes port 80 to the ACME server and forwards it to Traefik.
   Must verify during pilot. Alternative: switch to DNS-01 challenge using
   Cloudflare DNS API (cleaner, but means Traefik needs the CF token and
   you re-add a Cloudflare dependency for cert issuance only).
4. **Cloud cost stays the same, complexity rises.** More to operate on
   `cloud`. Pangolin needs Postgres + the Pangolin app + newt connector
   management + resource config + identity config.
5. **Migration is non-trivial.** Every Traefik `Host(...)` rule today works
   against a stable public IP. After the cutover, *every* service must be
   reachable via Pangolin — so the deploy workflow changes too. The deploy
   script (`scripts/deploy/+main.ts`) reads `SSH_ADDRESS` from `.env` to
   rsync and SSH; with no static IP you must SSH via Pangolin or a
   Tailscale/WireGuard mesh, which means the dev machine also needs the
   Pangolin client (or a stable hostname Pangolin gives the GMKTec).
6. **Self-hosting Pangolin is open-core (AGPL-3 / commercial).** The OSS
   build is fine for personal/hobbyist use. If you ever want paid features
   (advanced RBAC, audit logs, etc.), it's a commercial license.
7. **GMKTec UPNP/NAT stability still matters for outbound.** Pangolin's newt
   creates an outbound tunnel; if hotel Wi-Fi blocks WireGuard/UDP outright
   (rare but possible), the tunnel falls back to TCP. Check Pangolin's
   "Newt fallback to TCP" behavior before relying on it from a coffee shop.
8. **Renaming server in config files.** `servers/home/` is currently tied to
   the SG host. If you want to keep `servers/home/` (cleanest: this whole
   codebase refers to "home" as the *role*, not the host), only `.env` needs
   `SSH_ADDRESS` updated. If you rename, every reference (inventory,
   gatus, dash, ntfy topic names) changes.

### Cloud server RAM check

The `cloud` Hetzner VPS already runs 11 stacks. Will Pangolin fit alongside?

Current cloud footprint from compose limits (`servers/cloud/config.json` + per-stack `deploy.resources.limits`):

| Stack | Default mem limit | Worst case |
|---|---|---|
| stalwart | 512M | 512M |
| stalwart (aux containers) | 32M | 32M |
| bulwark | 512M | 512M |
| traefik | 512M | 512M |
| syncthing | 1024M | 1024M |
| ntfy | 128M | 128M |
| gatus | 128M | 128M |
| healthchecks | 512M | 512M |
| umami (app + db) | 512M + 512M | 1024M |
| caldiy (5 services) | 2G + 512M + 128M + 16M + ? | ~2.7 GB |
| nginx (neatsoft-landing) | 128M | 128M |
| librespeed, watchtower | not pinned | ~200M |
| **Current cloud total** | | **~7.5 GB** |

Pangolin footprint (from `compose.example.yaml` + docs):

| Component | Memory |
|---|---|
| pangolin (app) | 1 GB limit / 256 MB reservation |
| gerbil (WireGuard tunnel broker) | ~150 MB (Go binary, no published limit) |
| traefik (Pangolin's own, network_mode: gerbil) | ~150 MB |
| Postgres (Pangolin OSS uses SQLite or Postgres — Postgres if multi-site) | ~200 MB |
| **Pangolin total** | **~1.5 GB** |

Reference: https://docs.pangolin.net/self-host/choosing-a-vps recommends
"2 vCPU, 2 GB RAM, 20 GB SSD" as a baseline Pangolin VPS. Adding Pangolin
to an existing 8 GB+ cloud box is well within the published headroom.

**Action:** confirm the actual Hetzner plan in
`servers/cloud/README.md` (none of the docs show this explicitly — looks
like an oversight). Hetzner's smallest CX-line shared-CPU plans are 2 GB
(CX21) / 4 GB (CX22) / 8 GB (CX32). Anything 8 GB and up is safe; 4 GB
works but gets tight once backups or Immich restore scripts run. If you
discover the plan is ≤ 4 GB, either upgrade the VPS or move Pangolin to
the offsite RPi 4 (it has WireGuard + Traefik already, so it's the
closest thing to a Pangolin-ready box in the fleet — except it's only
4 GB RAM too and already runs Syncthing + LibreSpeed + Watchtower).

**Latent risk:** none of the current cloud stacks have `cpus: limits`
sums under the host — they share. After Pangolin + Gerbil + Pangolin's
own Traefik land, total CPU reservations are roughly: 0.5 + 0.5 + 1.0 +
1.0 + 0.2 + 0.2 + 0.5 + 0.5 + 1.0 + 2.0 + 0.1 + ~1.5 (Pangolin) ≈
9 vCPU of reservations. As long as the Hetzner plan has ≥ 4 vCPU, this
is fine; CPU is burstable on shared plans.

### Recommendation

**Yes, run Pangolin.** It's the right answer for the no-static-IP problem.
Mitigate the failure-mode risks by:

- Deploying Pangolin on the **same** `cloud` server that runs Stalwart
  (Hetzner VPS, already 24/7). Add a new `servers/cloud/stacks/pangolin/`
  stack (or compose directly inside the cloud server's apps dir).
- Keep WireGuard on the GMKTec as a parallel admin path (already in
  `servers/home/config.json`). If Pangolin ever dies, you still have a way
  in via Tailscale/WireGuard from your laptop.
- Switch ACME to **DNS-01** via Cloudflare API (one-time setup, decouples
  cert issuance from HTTP routing through Pangolin). This also lets you
  drop the `cloudflared` consideration from `docs/improvements.md` 4.1.

The Cloudflare wildcard A record for `*.antonshubin.com` currently points
to `165.173.1.38`. After cutover:

- Either keep Cloudflare as DNS-only and point `*.antonshubin.com` to
  Pangolin's public IP (Pangolin OSS exposes one public endpoint per
  resource — verify how it works in self-hosted mode).
- Or move authoritative DNS to Pangolin's built-in DNS for HTTP resources
  and keep Cloudflare only for mail records (`mail`, `_dmarc`,
  `_mta-sts`, DKIM, MX).

## 4. Migration plan

### Phase 0 — Verify backup integrity (SG is unreachable)

The SG box is dead and unreachable. **No data can be pulled off the SG
host** — that path is closed. All recovery comes from existing Restic
snapshots already replicated to `cloud` and `offsite` via Syncthing
(`~/sync/backups/*` is the standard layout per `docs/disaster-recovery.md`
§Backup Locations). Per the daily-cron pattern, snapshots exist for every
day the SG host was up until the last successful backup before it died.

1. **SSH into `cloud` and inventory the latest snapshots:**
   ```bash
   deno task ssh cloud ls ~/sync/backups/
   ```
   You should see one repo per service: `vaultwarden`, `immich`, `gitea`,
   `paperless`, `jellyfin`, `syncthing`, `gatus-home`, etc.
2. **For each repo, check the date of the latest snapshot:**
   ```bash
   RESTIC_PASSWORD="$BACKUPS_PASSWORD" restic -r ~/sync/backups/<service> snapshots
   ```
   The newest snapshot for each service tells you the recovery point.
3. **Accept data loss window.** Any data written after the last successful
   SG snapshot is gone. The gap is "1 day" in the best case (last backup
   was the night before the SSD died), "up to ~7 days" in the worst case
   (last successful backup was a week ago and the SSD died the day after).
   Immich is the highest-impact loss surface because every photo upload
   since the last snapshot is unrecoverable.
4. **Smoke-test a small restore** to confirm the repos are not corrupt:
   ```bash
   RESTIC_PASSWORD="$BACKUPS_PASSWORD" restic -r ~/sync/backups/vaultwarden \
     restore latest --target /tmp/test-restore
   ```
   Inspect `/tmp/test-restore` — if Vaultwarden's data dir is intact, the
   rest of the repos are likely fine (same Restic version, same password,
   same remote).
5. **Document the recovery point** per service before moving to Phase 1.
   You'll need this when restoring on GMKTec to know which services are
   safe to roll forward vs which need a hard "use last snapshot" cutoff.

### Phase 1 — Provision GMKTec K11 (Fedora KDE)

1. Install Fedora KDE latest on the GMKTec. Use the official ISO, not a
   respin. Encrypt the disk with LUKS (the SSD holds personal data — non-
   negotiable).
2. Create the `spy4x` user, add to `docker` group, enable passwordless sudo
   for the Ansible workflows (or use a sudo password in the Ansible config
   per `ansible/ansible.cfg`).
3. Install Docker + Docker Compose plugin + Deno using the existing
   playbook: `deno task ansible ansible/playbooks/initial-setup/base.yml home`.
   This is already Fedora-aware (`ansible/playbooks/initial-setup/base.yml`
   lines 53–67 handle `RedHat` family).
4. **Apply the Fedora Docker networking fix** (`servers/home/README_FEDORA.md`):
   `iptables -I DOCKER-USER -j ACCEPT` + systemd service. This is required
   for Traefik to receive external traffic — same fix as before, GMKTec
   hits the same Fedora issue.
5. Configure static local IP (LAN or hotel), but **don't depend on it**
   for public access. Pangolin handles that.
6. Mount + format the 4 TB NVMe as a single ext4 partition under
   `${BASE_PATH}` (e.g., `/mnt/nvme4t/`). Symlink or bind-mount to
   `~/ssd-2tb` so the existing `BASE_PATH=~/ssd-2tb` from
   `servers/home/.env.example` keeps working without rewrites.

### Phase 2 — Networking: Pangolin server + newt client

1. **On `cloud`** (Hetzner VPS):
   - Add `pangolin` stack to `servers/cloud/config.json`. Deploy:
     `deno task deploy cloud pangolin`.
   - The Pangolin server runs Postgres + the Pangolin NextJS app + the
     Gerbil tunnel broker (all three are part of the standard compose).
     See https://docs.pangolin.net/self-host/quick-install for the exact
     image set and version pins.
   - Bind Pangolin's public HTTP/HTTPS endpoint to the same ports the SG
     box currently uses (80, 443) — Pangolin's Traefik-like router does
     its own vhost matching, so you point domains at Pangolin via DNS.
2. **On GMKTec** (home role):
   - Install `newt` (Pangolin's connector binary): `newt` is a single
     Go binary. Wire it up as a systemd service so it survives reboots.
   - Register the GMKTec as a "site" in Pangolin's admin UI. Get the
     endpoint + token, store in `servers/home/.env` as
     `PANGOLIN_NEWT_ENDPOINT` and `PANGOLIN_NEWT_TOKEN` (encrypted in
     `.env.age`).
   - Define Pangolin **resources** for every domain in `docs/security-matrix.md`
     that currently resolves to the SG IP. For each:
     - Set the target to the corresponding Traefik upstream
       (e.g., `http://hl-jellyfin:8096`), or
     - Set the target to Traefik itself and let Traefik do vhost routing
       (cleaner — single resource per Traefik, `Host` headers preserve
       routing). Pick one; consistency wins. **Recommendation:** single
       resource pointing at Traefik on its internal Docker DNS name +
       non-standard port (`http://hl-traefik:8080` with a custom
       `Host` header pass-through).
3. **DNS cutover** for non-mail records:
   - Cloudflare wildcard `*.antonshubin.com` → change from `165.173.1.38`
     to Pangolin's public IP (Cloudflare DNS-only mode; Pangolin
     terminates TLS).
   - Mail records (`mail`, `_dmarc`, `_mta-sts`, DKIM, MX) **stay on
     Cloudflare → cloud server**. Mail doesn't go through Pangolin.
   - Wildcard is risky; consider explicit A records per service instead.
4. **ACME**: switch Traefik to DNS-01 challenge with Cloudflare API. Set
   `--certificatesresolvers.cf.acme.dnschallenge=true` and
   `--certificatesresolvers.cf.acme.dnschallenge.provider=cloudflare` plus
   the API token in `.env`. This decouples cert issuance from
   HTTP-01-over-Pangolin (avoids Con #3 above).

### Phase 3 — Service migration

The deploy workflow itself doesn't change — `scripts/deploy/+main.ts` reads
`SSH_ADDRESS` from `servers/home/.env` and rsyncs + SSHes. The only
difference is what `SSH_ADDRESS` is.

1. **Update `servers/home/.env`**:
   - `SSH_ADDRESS=spy4x@gmktec-home.pangolin.internal` (or whatever Pangolin
     calls the GMKTec site; or a Tailscale IP like `100.64.x.x` if you
     keep Tailscale as the SSH transport).
   - `SSH_PORT=22` (or whatever Pangolin's per-resource port is).
   - `BASE_PATH=~/nvme4t` (or wherever you mount the NVMe on GMKTec).
2. **Decrypt** the home `.env.age` in the worktree: `deno task env:decrypt`.
3. **Deploy base stacks first** (Traefik, Syncthing, Watchtower):
   ```bash
   deno task deploy home traefik
   deno task deploy home syncthing
   deno task deploy home watchtower
   deno task deploy home wireguard   # keep as parallel admin path
   deno task deploy home gatus      # cross-server monitoring
   deno task deploy home ntfy
   ```
4. **Restore data from Restic snapshots** — see `docs/disaster-recovery.md`
   §7. Priority order:
   1. `vaultwarden` (passwords first)
   2. `authelia` (so other things auth)
   3. `immich` (largest dataset, longest restore)
   4. `gitea`, `paperless-ngx`, `jellyfin`, `syncthing`, others
5. **Deploy the remaining stacks** one batch at a time, verifying each:
   ```bash
   deno task deploy home           # full deploy per config.json
   ```
   Watch for first-boot issues: ACME cert issuance (DNS-01), Authelia
   session persistence, Immich ML warmup (CPU/VAAPI first run is slow).
6. **NVIDIA → CPU/VAAPI conversions** (required, the SG box had CUDA):
   - `stacks/jellyfin/compose.yml`: change `driver: nvidia` to
     `driver: vaapi` and add `/dev/dri:/dev/dri` devices. Or drop GPU
     entirely and let CPU transcode.
   - `stacks/paperless-ngx/compose.yml`: drop the NVIDIA blocks
     (Tesseract CPU is fine for personal-scale OCR).
   - `stacks/immich/`:
     - `compose.yml`: change `service: nvenc` to `service: vaapi` in the
       `extends` block (line 21).
     - `hwaccel.transcoding.yml`: replace NVENC block with VAAPI block
       (Immich docs cover this — VAAPI uses `/dev/dri/renderD128`).
     - `hwaccel.ml.yml`: replace CUDA block with OpenVINO (the
       `-openvino` image tag uses Intel CPU acceleration; runs fine on
       AMD Zen4 via oneDNN).
     - Image tag: drop `-cuda` suffix from the ML container image.
7. **DNS TTL warning:** the wildcard `*.antonshubin.com` → new IP should
   be done during a low-traffic window. Old TTL is whatever Cloudflare is
   set to (default 300s auto); the cache clears in 5 min.

### Phase 4 — Verification

Per the repo's `AGENTS.md` "Deploy & Verify" rule:

1. Smoke-test every domain in `docs/security-matrix.md` against the new
   Pangolin-fronted path. Check HTTP-01 → 302, real backend → 200, auth
   wall → 302 to Authelia.
2. Gatus on `cloud` should still see all home services healthy (now
   through Pangolin instead of direct).
3. Run `deno task backup` once manually — verify Restic snapshots land in
   `~/sync/backups/*` on GMKTec and Syncthing replicates to cloud.
4. Authelia 2FA flow end-to-end: log into a 2FA-protected domain, confirm
   TOTP prompt + session cookie.
5. Pull the SG server offline (or ask your friend to). Confirm everything
   still serves from GMKTec.

### Phase 5 — Decommission SG

1. After 7 days of stable operation on GMKTec:
   - Wipe the SG SATA SSD (cryptographic erase if the drive supports it,
     else `blkdiscard` or full `dd` zero).
   - Donate / recycle / shelve the hardware.
2. Remove `servers/home/.env`'s reference to the SG host's SSH keys
   (rotate keys if SG had access to anything outside its own subnet).
3. Update `docs/architecture.md` server table — the SG host row becomes
   "GMKTec K11 (Fedora KDE, portable)".
4. Update `docs/disaster-recovery.md` §Server Inventory table.
5. Update `docs/improvements.md` and `README.md` to reflect new
   hardware facts.

## 5. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Pangolin server outage cuts off home | low (Hetzner 99.99%) | high | WireGuard stays as parallel admin path; Tailscale fallback on laptop |
| Let's Encrypt HTTP-01 fails through Pangolin | medium | medium | Use DNS-01 with Cloudflare API instead |
| K11 hardware failure during travel | medium | high | Syncthing replicates to cloud + offsite daily; offsite RPi is backup-of-backup |
| GPU/CPU mismatch on Immich ML | medium | medium | OpenVINO image tag, accept slower inference vs CUDA |
| Single 4 TB NVMe, no redundancy | medium | high | Restic to external drive monthly (`deno task offline-backup`); cloud + offsite replication covers total loss |
| Power loss on travel | high | low | UPS recommended at fixed locations; Syncthing catches up on next boot |
| Hotel Wi-Fi blocks WireGuard UDP | low | high | Verify Pangolin's TCP fallback; carry USB-Ethernet adapter as backup |
| Cloud Hetzner VPS plan too small for Pangolin | low | medium | Check plan size before deploying Pangolin; upgrade if needed |

## 6. What this doc does NOT cover (open questions for you)

- **Exact Pangolin version + image pin.** Will set in `stacks/pangolin/compose.yml`
  at implementation time. Reference https://docs.pangolin.net/self-host/quick-install.
- **OCuLink eGPU** — kept off the table. Defer until you actually need it.
- **Restic retention strategy on a single 4 TB disk.** Today backups live in
  `~/sync/backups/*` which is Syncthing-replicated. With 4 TB of disk and
  ~hundreds of GB of photos + backups, you have ~3 TB free. Plenty for
  7 daily + 4 weekly + 3 monthly snapshots. Watch disk space.
- **Hotel/portable power strategy.** A 120W PSU brick is fine in a hotel
  room; flaky in some hotel rooms with weak circuits. Consider a small
  UPS if you'll keep it plugged in long-term in one place.
- **Do you keep `servers/home/` as the directory name?** Recommended: yes,
  it's a role not a host. Only `.env` changes.
- **Exact Hetzner cloud plan** — needs verification. RAM analysis assumes
  ≥ 8 GB; below 4 GB needs a plan upgrade.

## 7. References

- Pangolin docs: https://docs.pangolin.net/
- Pangolin source: https://github.com/fosrl/pangolin (21.9k stars, AGPL-3)
- Immich hardware transcoding: https://immich.app/docs/features/hardware-transcoding
- Traefik DNS-01 + Cloudflare: https://doc.traefik.io/traefik/https/acme/#dnschallenge
- Repo disaster recovery: `docs/disaster-recovery.md`
- Fedora Docker fix: `servers/home/README_FEDORA.md`
- GMKTec K11 specs: https://www.gmktec.com/products/amd-ryzen%E2%84%A2-9-8945hs-nucbox-k11
  (Ryzen 9 8945HS, Radeon 780M iGPU, 96 GB DDR5 max, dual 2.5 GbE, OCuLink)