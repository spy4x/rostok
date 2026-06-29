# Stalwart Migration — To-Do (ordered by urgency)

## 🔴 BLOCKING — Mail delivery

- [ ] **Wait for DNS TTL to propagate** — `mail.antonshubin.com` A record updated to `23.88.101.28` (cloud). Cloudflare confirmed. Local DNS still cached. Until it flips, mail still goes to home server's old DMS.
- [ ] **Test inbound mail** — After DNS flip, send a test email to verify Stalwart receives and stores it.
- [ ] **Test outbound mail (587)** — Port 587 submission refused from outside. Check Hetzner cloud firewall / if old DMS is still holding port 587 on home.

## 🟠 HIGH — Post-flip cleanup

- [ ] **Remove old DMS DKIM selectors from DNS** — `mail._domainkey.antonshubin.com` is a stale record from old DMS. Stalwart uses `v1-ed25519-20260629` and `v1-rsa-20260629`.
- [ ] **Add Stalwart monitoring endpoint to Gatus** — Cross-server health check from home Gatus.
- [ ] **Add Stalwart to Cloud dashboard** — `servers/home/configs/dash/index.html.template`
- [ ] **Remove temporary port 8080** — Already removed from `compose.yml` and deployed. Confirm Traefik still routes to container's internal 8080 (it does via `loadbalancer.server.port=8080` label).
- [ ] **Update `.env.example`** with correct `STALWART_SUBDOMAIN` and `STALWART_ADMIN_PASSWORD`.

## 🟡 MEDIUM — Decommission DMS

- [ ] **Stop and remove DMS container** on home server.
- [ ] **Remove DMS volumes** after verifying backup.
- [ ] **Remove SnappyMail stack** (`stacks/snappymail`) — Stalwart has built-in webmail.
- [ ] **Remove `extract-certs.sh`** flow — Stalwart has native ACME.
- [ ] **Remove mailserver from servers/home/config.json**.

## 🔵 LOW — Improvements

- [ ] **Fix Cloud Traefik dashboard 500** — `https://proxy-cloud.antonshubin.com/` returns 500. Pre-existing, not caused by migration.
- [ ] **Update server READMEs** — Document new mail architecture in `servers/cloud/README.md` and `servers/home/README.md`.
- [ ] **Verify JMAP works from FairEmail / Thunderbird** — Test push notifications, calendar sync.
- [ ] **Set up DMARC reporting** — Stalwart has built-in DMARC report generation.
