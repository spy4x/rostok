# Stalwart Mail Server

[Stalwart Mail](https://stalw.art/) — Modern all-in-one mail server written in Rust.

## Features

- **SMTP** (inbound 25, submission 465/587)
- **IMAP4** (993) with JMAP (RFC 8620/8621)
- **JMAP** for modern clients (push notifications, server-side search)
- **CalDAV/CardDAV** — calendars, tasks, contacts via JMAP + WebDAV
- **Built-in Webmail** at `/admin` (port 8080, proxied via Traefik)
- **DKIM/ARC/DMARC/SPF** signing and verification
- **Built-in anti-spam** (Bayesian, DNSBL, rate limiting)
- **ACME** (Let's Encrypt) native — no external cert management needed
- **Single binary** — no Postfix/Dovecot/Rspamd/Redis complexity

## Configuration

- **Config file:** `/etc/stalwart/config.json` (managed via admin UI)
- **Data:** `/var/lib/stalwart/data` (SQLite database)
- **Volumes:** `data/` (SQLite), `config/` (config.json), `lib/` (runtime data)

## Access

- **Admin UI:** `https://stalwart.antonshubin.com/admin`
- **SMTP submission:** `mail.antonshubin.com:587` (STARTTLS) / `:465` (TLS)
- **IMAP:** `mail.antonshubin.com:993` (TLS)
- **JMAP:** `https://mail.antonshubin.com/jmap/`
- **CalDAV:** `https://mail.antonshubin.com/caldav/{email}/` (or `cal.antonshubin.com`)
- **CardDAV:** `https://mail.antonshubin.com/carddav/{email}/`
- **CalDAV legacy domain:** `https://cal.antonshubin.com/` (replaces Radicale)

## Admin Account

Configured via `STALWART_RECOVERY_ADMIN` env var. First login at `/admin` uses the recovery password to set up the admin account.

## DNS Records

| Record                                               | Value                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `antonshubin.com` A                                  | `165.173.1.38` (home origin, Cloudflare-proxied)            |
| `mail.antonshubin.com` A                             | `23.88.101.28` (cloud, DNS-only — never proxy SMTP)         |
| `cal.antonshubin.com` A                              | `23.88.101.28` (cloud)                                      |
| `antonshubin.com` MX                                 | `mail.antonshubin.com`                                      |
| `antonshubin.com` SPF                                | `v=spf1 mx ip4:23.88.101.28 -all`                           |
| `_dmarc.antonshubin.com` TXT                         | `v=DMARC1; p=reject; rua=mailto:postmaster@antonshubin.com` |
| `_mta-sts.antonshubin.com` TXT                       | `v=STSv1; id=20260702`                                      |
| `_smtp._tls.antonshubin.com` TXT                     | `v=TLSRPTv1; rua=mailto:postmaster@antonshubin.com`         |
| `v1-ed25519-20260702._domainkey.antonshubin.com` TXT | DKIM Ed25519 key                                            |
| `v1-rsa-20260702._domainkey.antonshubin.com` TXT     | DKIM RSA key                                                |
| `v1-ed25519-20260702._domainkey.neatsoft.dev` TXT    | DKIM Ed25519 key                                            |
| `v1-rsa-20260702._domainkey.neatsoft.dev` TXT        | DKIM RSA key                                                |

`before.deploy.ts` and `after.deploy.ts` enforce manual DKIM management while
Cloudflare DNS publication remains manual. Post-deploy verification fails if
either domain lacks matching active Ed25519 and RSA TXT records.

Only first deployment, when no live Stalwart endpoint exists, may bypass
preflight with `STALWART_INITIAL_DEPLOY=true deno task deploy cloud stalwart`.
Post-deploy DKIM verification remains mandatory.

The apex is proxied, so `dig antonshubin.com` returns Cloudflare addresses
rather than the origin above. `mail.` and the `_domainkey` records must stay
DNS-only: proxying them would hide the real SMTP address and break DKIM
lookups.

Retired selectors are deleted from DNS once no signature references them.
The `v1-*-20260629` pair on both domains and the docker-mailserver-era
`mail._domainkey.neatsoft.dev` were removed on 2026-08-19; only the active
`20260702` pair above is published. Leaving a superseded selector in DNS keeps
its old private key able to sign mail that still passes DKIM.

## Ports

External mail ports (25, 465, 587, 993) are published. **Port 25 requires Hetzner support ticket to unblock** for inbound mail from external servers.

## Upgrade

```bash
docker pull stalwartlabs/stalwart:latest
deno task deploy cloud stalwart
```

## Migration

Stalwart replaces the older `docker-mailserver` stack. The migration
involves exporting mailboxes / DKIM keys from the old setup and
importing them into Stalwart via the admin API. As of this rewrite
the migration is not first-class — the user runs the steps manually.
