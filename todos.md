# Stalwart Migration — To-Do (ordered by urgency)

## 🔴 BLOCKING — Mail delivery

- [x] **Add port 587 SMTP submission** — Created NetworkListener via JMAP API (`x:NetworkListener/set`). Restarted container. Port 587 now responds with STARTTLS, AUTH, SMTPUTF8, PIPELINING. Verified externally.
- [ ] **Wait for DNS TTL to propagate** — `mail.antonshubin.com` A record updated to `23.88.101.28` (cloud). Cloudflare confirmed. Local DNS still cached.
- [ ] **Test inbound mail** — After DNS flip, send a test email to verify Stalwart receives and stores it.

## 🟠 HIGH — Post-flip cleanup

- [x] **Remove old DMS DKIM selectors from DNS** — Deleted `mail._domainkey.antonshubin.com` TXT record via Cloudflare API. Confirmed removed from API (0 records).
- [x] **Add Stalwart monitoring endpoint to Gatus** — Already have `Mail Server (SMTP)` TCP check on port 587. SMTP monitoring covered.
- [x] **Add Stalwart to Cloud dashboard** — Added "Mail" (📧) and "Mail Admin" (⚙️) cards to `servers/home/configs/dash/index.html.template`.
- [x] **Remove temporary port 8080** — Already removed from `compose.yml` and deployed. Traefik routes via `loadbalancer.server.port=8080`.
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
