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

`rostok stack add stalwart` writes these to `.env`:

| Variable                            | Default             | Description                                                                                            |
| ----------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `STALWART_DOMAIN`                   | `mail.${DOMAIN}`    | Host of the web UI and JMAP. The deploy hooks and cert-sync assume `mail.${DOMAIN}`.                   |
| `STALWART_MTA_STS_DOMAIN`           | `mta-sts.${DOMAIN}` | Host serving the MTA-STS policy of the primary domain.                                                 |
| `STALWART_MTA_STS_SECONDARY_DOMAIN` | `mta-sts.${DOMAIN}` | Same for a second mail domain; leave the default with one domain.                                      |
| `STALWART_NEATSOFT_DOMAIN`          | `${DOMAIN}`         | Second mail domain on the same MX, whose DKIM the deploy hooks check. The key keeps its original name. |
| `STALWART_ADMIN_PASSWORD`           | generated           | Password of the `admin` account.                                                                       |
| `STALWART_INITIAL_DEPLOY`           | `false`             | `true` only for the first deploy, before any Stalwart is running.                                      |
| `STALWART_MEM_LIMIT`                | `512M`              | Container memory limit.                                                                                |
| `STALWART_CPU_LIMIT`                | `0.5`               | Container CPU limit.                                                                                   |

- **Config file:** `/etc/stalwart/config.json` (managed via admin UI)
- **Data:** `/var/lib/stalwart/data` (SQLite database)
- **Volumes:** `data/` (SQLite), `config/` (config.json), `lib/` (runtime data)

## Access

- **Admin UI:** `https://stalwart.example.com/admin`
- **SMTP submission:** `mail.example.com:587` (STARTTLS) / `:465` (TLS)
- **IMAP:** `mail.example.com:993` (TLS)
- **JMAP:** `https://mail.example.com/jmap/`
- **CalDAV:** `https://mail.example.com/caldav/{email}/` (or `cal.example.com`)
- **CardDAV:** `https://mail.example.com/carddav/{email}/`
- **CalDAV legacy domain:** `https://cal.example.com/` (replaces Radicale)

## Admin Account

Configured via `STALWART_RECOVERY_ADMIN` env var. First login at `/admin` uses the recovery password to set up the admin account.

## DNS Records

| Record                                           | Value                                                   |
| ------------------------------------------------ | ------------------------------------------------------- |
| `example.com` A                                  | `198.51.100.7` (home origin, Cloudflare-proxied)        |
| `mail.example.com` A                             | `203.0.113.10` (cloud, DNS-only — never proxy SMTP)     |
| `cal.example.com` A                              | `203.0.113.10` (cloud)                                  |
| `example.com` MX                                 | `mail.example.com`                                      |
| `example.com` SPF                                | `v=spf1 mx ip4:203.0.113.10 -all`                       |
| `_dmarc.example.com` TXT                         | `v=DMARC1; p=reject; rua=mailto:postmaster@example.com` |
| `_mta-sts.example.com` TXT                       | `v=STSv1; id=20260702`                                  |
| `_smtp._tls.example.com` TXT                     | `v=TLSRPTv1; rua=mailto:postmaster@example.com`         |
| `v1-ed25519-20260702._domainkey.example.com` TXT | DKIM Ed25519 key                                        |
| `v1-rsa-20260702._domainkey.example.com` TXT     | DKIM RSA key                                            |
| `v1-ed25519-20260702._domainkey.example.org` TXT | DKIM Ed25519 key                                        |
| `v1-rsa-20260702._domainkey.example.org` TXT     | DKIM RSA key                                            |

`before.deploy.ts` and `after.deploy.ts` enforce manual DKIM management while
Cloudflare DNS publication remains manual. Post-deploy verification fails if
either domain lacks matching active Ed25519 and RSA TXT records.

Only first deployment, when no live Stalwart endpoint exists, may bypass
preflight with `STALWART_INITIAL_DEPLOY=true deno task deploy cloud stalwart`.
Post-deploy DKIM verification remains mandatory.

The apex is proxied, so `dig example.com` returns Cloudflare addresses
rather than the origin above. `mail.` and the `_domainkey` records must stay
DNS-only: proxying them would hide the real SMTP address and break DKIM
lookups.

Retired selectors are deleted from DNS once no signature references them.
The `v1-*-20260629` pair on both domains and the docker-mailserver-era
`mail._domainkey.example.org` were removed on 2026-08-19; only the active
`20260702` pair above is published. Leaving a superseded selector in DNS keeps
its old private key able to sign mail that still passes DKIM.

## DKIM verification (`dkim-verify.ts`)

`stacks/stalwart/dkim-verify.ts` is a pure-Deno RFC 6376 DKIM signature
verifier — both `rsa-sha256` and `ed25519-sha256`. Pure functions, no
Stalwart dependency, usable from any Deno script or `deno repl`.

### Why it exists

DMARC aggregate reports from Google (delivered to `postmaster@`) report
failures per selector. Distinguishing the three classes of failure
("no signature at all" vs "signature but algorithm broken" vs "receiver
doesn't implement RFC 8463") requires checking the actual signed message
against the published public key — which is what this module does.

Used during [#141](https://github.com/spy4x/rostok/issues/141) to
distinguish the historical failure modes (no signature pre-#131) from
the ongoing Ed25519-at-Google noise.

### API

```ts
import { parseDkimPublicKey, verifyDkim } from "./stacks/stalwart/dkim-verify.ts"

// Fetch the public key from DNS (or wherever) and verify
const pubKey = parseDkimPublicKey(
  "v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8...",
)
const result = await verifyDkim(rawMessage, pubKey)
// result: { valid: boolean, reason?: string, parsed?, computedBodyHash?, ... }
```

`verifyDkim` accepts the raw RFC822 message (with whatever line endings
IMAP serves you) and the parsed public key. It folds continuation
headers, canonicalises per the `c=` tag (relaxed/relaxed default),
recomputes the body hash, and verifies the signature with WebCrypto.

### Regression check after deploy

A round-trip is worth running once after any deploy that touches the
DKIM pipeline:

```sh
# Send a test message via SMTP submission, then read it back via JMAP
# and verify the signature against the published DNS key. See issue #141
# for the full reproduction script.
```

If `result.valid === true` for the `rsa-sha256` selector, outbound
mail is signing correctly. Ed25519 will report `invalid` at Google
regardless — that's RFC 8463 not being implemented there, not our bug.

### Tolerates real-world input

- Mixed CRLF/LF line endings (IMAP servers sometimes normalise mid-stream)
- Folded continuation headers (Stalwart emits multi-line DKIM-Signature)
- Folded values across line breaks (`bh=AAA\n\tBBB` → `bh=AAABBB`)

17 unit tests cover the round-trip (sign with generated keypair, verify
with the verifier). Tests are in `dkim.verify.test.ts`.

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

## Deploy order

The `cert-sync` sidecar mounts Traefik's
`${VOLUMES_PATH}/traefik/letsencrypt/acme.json`. `+meta.ts` declares it
in `fileMounts`, so deploy checks that the file exists before it changes
any stack, stops if it doesn't, and never creates a folder in its place.
On a new server, deploy Traefik first and let it start once, so it
writes `acme.json`. If this stack is already in `config.json`, run
`rostok deploy <server> traefik` for that first deploy, then deploy the
whole server.
