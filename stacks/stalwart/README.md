# Stalwart Mail Server

[Stalwart Mail](https://stalw.art/) — Modern all-in-one mail server written in Rust.

## Features

- **SMTP** (inbound 25, submission 465/587)
- **IMAP4** (993) with JMAP (RFC 8620/8621)
- **JMAP** for modern clients (push notifications, server-side search)
- **CalDAV/CardDAV** — calendars, tasks, contacts via JMAP + WebDAV
- **Built-in Webmail** at `/admin` (port 8080, proxied via Traefik)
- **DKIM/ARC/DMARC/SPF** signing and verification
- **No outbound reports** — the deploy hook turns off the DMARC, TLS, DKIM and SPF reports
  Stalwart would mail to every domain that writes to you. Reports other servers send you still
  arrive at `postmaster@`. Logic: `reports.ts`.
- **Built-in anti-spam** (Bayesian, DNSBL, rate limiting)
- **ACME** (Let's Encrypt) native — no external cert management needed
- **Single binary** — no Postfix/Dovecot/Rspamd/Redis complexity

## Configuration

`rostok stack add stalwart` writes these to `.env`:

| Variable                  | Default                     | Description                                                                                       |
| ------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| `STALWART_DOMAIN`         | `mail.${DOMAIN}`            | Host of the web UI and JMAP. The deploy hooks and cert-sync assume `mail.${DOMAIN}`.              |
| `STALWART_MTA_STS_DOMAIN` | `mta-sts.${DOMAIN}`         | Host serving the MTA-STS policy of the primary domain.                                            |
| `STALWART_WEBMAIL_ORIGIN` | `https://webmail.${DOMAIN}` | The one browser origin allowed to call JMAP from another host: the webmail (the `bulwark` stack). |
| `STALWART_EXTRA_DOMAINS`  | none                        | Further mail domains on the same MX, comma-separated (`example.org,example.net`). Optional.       |
| `STALWART_ADMIN_PASSWORD` | generated                   | Password of the `admin` account.                                                                  |
| `STALWART_INITIAL_DEPLOY` | `false`                     | `true` only for the first deploy, before any Stalwart is running.                                 |
| `STALWART_MEM_LIMIT`      | `512M`                      | Container memory limit.                                                                           |
| `STALWART_CPU_LIMIT`      | `0.5`                       | Container CPU limit.                                                                              |

### More than one mail domain

`DOMAIN` is the primary mail domain. List every further domain this server receives mail for in
`STALWART_EXTRA_DOMAINS`. For each one the deploy:

- keeps its DKIM management manual and checks its active DKIM keys in public DNS,
- routes `https://mta-sts.<domain>` to the MTA-STS policy server (same policy, same MX),
- lets cert-sync copy the `mail.<domain>` certificate when Traefik holds one.

Compose cannot loop over a list, so `before.deploy.ts` writes these into the copy of `compose.yml`
that goes to the server: one Traefik router per extra domain (`hl-mta-sts-<domain>`, dots as
underscores) and the `mail.<domain>` hosts on the `CERT_SYNC_DOMAINS` line. They live in
`stacks/stalwart/` on the server, so deploying another stack alone, or a `docker compose up` run on
the server, keeps every extra domain. Never edit the server's copy: the next deploy rewrites it.

Each `mta-sts.` host has its own router, so Traefik orders each certificate by itself. An extra
domain whose `mta-sts.` DNS record is missing gets no certificate, and no other host is affected.

The same hook renders the MTA-STS policy, `mta-sts/html/.well-known/mta-sts.txt`, from the
template beside it. Both steps write into the deploy's staging copy of this stack, never into the
catalog, so they work the same when rostok is installed from JSR.

### Upgrading from `STALWART_NEATSOFT_DOMAIN`

The key `STALWART_NEATSOFT_DOMAIN` (one second mail domain) is no longer read. In
`servers/<server>/.env`:

- a second mail domain: rename the key, `STALWART_EXTRA_DOMAINS=example.org`. Until you do, the
  deploy stops with an error before anything is synced, so the second domain is never dropped
  silently;
- one mail domain (the line is blank, `${DOMAIN}` or the primary domain): the deploy carries on
  and prints one line asking you to delete it.

`STALWART_MTA_STS_SECONDARY_DOMAIN` is no longer read: the policy host of a domain is always
`mta-sts.<domain>`, as the MTA-STS standard requires. Delete that line too, then run
`rostok env encrypt`.

Certificates: the primary router keeps its name (`hl-mta-sts-primary`) and the second domain's
router is renamed, but Traefik stores certificates by host name. A server that already serves
`mta-sts.<domain>` for both domains keeps both certificates and orders nothing new. Only a host
Traefik has never served gets a new certificate.

The CORS rule for the webmail moved from the Traefik stack's `dynamic/00-base.yml` to this stack's
own router. It allows `STALWART_WEBMAIL_ORIGIN`, by default `https://webmail.${DOMAIN}`; set the
key when the webmail lives on another host.

**Deploy order for this upgrade.** Deploy the whole server (`rostok deploy <server>`), or
`stalwart` first and `traefik` after it. Both stacks change together: the new Traefik files no
longer define `stalwart-jmap@file`, and the new stalwart router no longer uses it.

If `traefik` is deployed alone first, the stalwart stack still running names a middleware that is
gone, and Traefik switches that router off. What you see:

- `https://mail.<domain>/` answers `404 page not found`, so the admin page and the webmail's
  connection to the mail server stop. Mail delivery (ports 25, 465, 587, 993) is not affected.
- Traefik's log says `middleware "stalwart-jmap@file" does not exist`.
- `rostok deploy <server> stalwart` then stops at `live Stalwart health check failed: HTTP 404`,
  because the hook asks the live server through that router.

To recover, set `STALWART_INITIAL_DEPLOY=true` in the server's `.env`, deploy `stalwart`, and
remove the line again. That one deploy skips the DKIM step before the sync (the one after it still
runs) and brings the router back with its own middleware.

Be careful with that flag on a live mail server. While it is set, any failure after the deploy (a
health wait that times out, one failed DKIM lookup) stops the `hl-stalwart` container, and SMTP and
IMAP go down with it. If that happens, start the container on the server
(`docker start hl-stalwart`), or deploy `stalwart` again with the flag still set; a deploy without
the flag cannot run while the container is stopped. Remove the flag once a deploy has gone
through, and never leave it in `.env`.

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

`scripts/stalwart/dkim-verify.ts` is a pure-Deno RFC 6376 DKIM signature
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
import { parseDkimPublicKey, verifyDkim } from "./scripts/stalwart/dkim-verify.ts"

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

## A sending account for an app

An app that mails people (a site's newsletter, a contact form) should log in
to SMTP with an account of its own, never with the owner's personal password.
`scripts/stalwart/ensure-account.ts` creates such an account and, with
`--redirect`, installs a Sieve script on it that forwards every reply to the
owner's own address, so replies reach a mailbox someone reads:

```bash
E=servers/<server>/.env
STALWART_ADMIN_PASSWORD="$(sed -n 's/^STALWART_ADMIN_PASSWORD=//p' "$E")" \
APP_PW="$(sed -n 's/^APP_PW=//p' "$E")" \
deno run -A scripts/stalwart/ensure-account.ts \
  --server mail.example.com --address hello@example.com \
  --description "Jane Doe" --password-env APP_PW --redirect jane@example.com
```

Keep the password in the server's `.env` (then `deno task env:encrypt`) and in
the app's own env. The script is idempotent: an existing account and its
password are left alone, and the redirect script is replaced on every run. A
refused script upload fails the run, and an account that another active Sieve
script already filters (an owner's own mailbox) is refused, not overwritten.
Stalwart only lets an account send from its own addresses, so the app's `From`
is the new address; a display name (`Jane Doe <hello@example.com>`) is fine.
