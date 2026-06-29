# Stalwart Migration — To-Do (ordered by urgency)

## ✅ DONE

- [x] **DNS zone published to Cloudflare** — All DKIM, TLSA, SRV, MTA-STS, CNAME records published
- [x] **Passwords rotated** — New strong passwords for anton@antonshubin.com and anton@neatsoft.dev
- [x] **Cert auto-renewal cron as stack** — `cert-sync` service in `stacks/stalwart/compose.yml` runs daily at 3:15 AM
- [x] **mail-ai removed** — Containers stopped, volumes cleaned, stack directory removed from repo
- [x] **.env updated** — STALWART_ADMIN_PASSWORD added, MAIL_AI vars removed from both .env and .env.example
- [x] **System cron migrated to Docker** — Old `crontab` entry removed, replaced by hl-cert-sync container
- [x] **TLS serving** — Both mail.antonshubin.com and mail.neatsoft.dev serve valid Let's Encrypt certs
- [x] **Catch-all forwarding** — *@antonshubin.com → anton@antonshubin.com, *@neatsoft.dev → anton@neatsoft.dev
- [x] **Old emails imported** — 1637 (antonshubin.com) + 206 (neatsoft.dev) emails migrated via Vandelay
- [x] **Accounts deployable** — STALWART_ADMIN_PASSWORD in .env, compose deploys cleanly

## 🟡 MEDIUM — Future cleanup

- [ ] **Remove DMS container/volumes** on home server (after 30-day verification)
- [ ] **Remove SnappyMail stack** (`stacks/snappymail`) — Stalwart has built-in webmail
- [ ] **Fix Cloud Traefik dashboard 500** — Pre-existing, not caused by migration

## 🔵 LOW — Improvements

- [ ] **Verify JMAP works from FairEmail / Thunderbird** — Test push notifications, calendar sync
- [ ] **Set up DMARC reporting** — Stalwart has built-in DMARC report generation
