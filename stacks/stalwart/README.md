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
| `antonshubin.com` A                                  | `165.173.1.38` (cloud)                                      |
| `mail.antonshubin.com` A                             | `165.173.1.38` (cloud)                                      |
| `cal.antonshubin.com` A                              | `23.88.101.28` (cloud)                                      |
| `antonshubin.com` MX                                 | `mail.antonshubin.com`                                      |
| `antonshubin.com` SPF                                | `v=spf1 mx ip4:23.88.101.28 -all`                           |
| `_dmarc.antonshubin.com` TXT                         | `v=DMARC1; p=reject; rua=mailto:postmaster@antonshubin.com` |
| `_mta-sts.antonshubin.com` TXT                       | `v=STSv1; id=20260702`                                      |
| `_smtp._tls.antonshubin.com` TXT                     | `v=TLSRPTv1; rua=mailto:postmaster@antonshubin.com`         |
| `v1-ed25519-20260629._domainkey.antonshubin.com` TXT | DKIM Ed25519 key                                            |
| `v1-rsa-20260629._domainkey.antonshubin.com` TXT     | DKIM RSA key                                                |

## Ports

External mail ports (25, 465, 587, 993) are published. **Port 25 requires Hetzner support ticket to unblock** for inbound mail from external servers.

## Upgrade

```bash
docker pull stalwartlabs/stalwart:latest
deno task deploy cloud stalwart
```

## Migration

See `docs/migrate-from-docker-mailserver-to-stalwart.md` for the full migration plan from docker-mailserver.
