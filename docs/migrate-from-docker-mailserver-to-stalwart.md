# Migrate from docker-mailserver (DMS) to Stalwart Mail

> **Status:** ✅ **OPERATIONAL** — Stalwart running on `cloudlab` (Hetzner VM, `23.88.101.28`).
> TLS, catch-all, DNS zone, cert auto-renewal all deployed. Old emails migrated.
> Only legacy DMS and SnappyMail cleanup remains (30-day verification window).

This document describes how to move the personal mail server currently running
`ghcr.io/docker-mailserver/docker-mailserver` (DMS) on `cloudlab` (Hetzner nbg1,
`23.88.101.28`) to [Stalwart Mail](https://stalw.art/), a single-binary Rust
mail server with native **JMAP** ([RFC 8620](https://datatracker.ietf.org/doc/html/rfc8620)/[RFC 8621](https://datatracker.ietf.org/doc/html/rfc8621)),
IMAP4, ManageSieve, CalDAV/CardDAV-via-JMAP, SMTP, DKIM/ARC/DMARC/SPF, and
built-in anti-spam — without losing a single message, alias, DKIM key, or
client config that we can avoid changing.

---

## Table of contents

1. [Goals](#1-goals)
2. [Why Stalwart (and JMAP) is better than the current stack](#2-why-stalwart-and-jmap-is-better-than-the-current-stack)
3. [Client compatibility — Android + Fedora KDE](#3-client-compatibility--android--fedora-kde)
4. [Pre-migration inventory](#4-pre-migration-inventory)
5. [Migration phases](#5-migration-phases)
6. [Phase 0 — Backup everything (no change)](#6-phase-0--backup-everything-no-change)
7. [Phase 1 — Deploy Stalwart alongside DMS (parallel run)](#7-phase-1--deploy-stalwart-alongside-dms-parallel-run)
8. [Phase 2 — Import accounts, aliases, DKIM keys, Maildir](#8-phase-2--import-accounts-aliases-dkim-keys-maildir)
9. [Phase 3 — Validate IMAP/SMTP from Thunderbird](#9-phase-3--validate-imapsmtp-from-thunderbird)
10. [Phase 4 — Cutover](#10-phase-4--cutover)
11. [Phase 5 — Decommission DMS](#11-phase-5--decommission-dms)
12. [PR checklist](#12-pr-checklist)
13. [Open questions / decisions](#13-open-questions--decisions)
14. [Should you message Hetzner?](#14-should-you-message-hetzner)
15. [Appendix A — Side-by-side feature matrix](#appendix-a--side-by-side-feature-matrix)

---

## 1. Goals

- **Zero message loss.** Every email in `mail-data/` must end up in Stalwart,
  including sub-folders, flags (`\Seen`, `\Flagged`, `\Answered`), and
  `X-Original-To` headers preserved.
- **Zero password reset for users.** SHA512-CRYPT hashes in
  `postfix-accounts.cf` must migrate transparently. (See [§ 8.1](#81-accounts).)
- **Zero DKIM reconfiguration.** The two `rsa-2048-mail-<domain>.private.txt`
  keys must continue signing the same domains with the same `d=`, `s=`, `k=`,
  and `h=` tags so published DNS records stay valid. (See [§ 8.3](#83-dkim).)
- **Reversible.** Every step has a documented rollback. We do not delete DMS
  data until 30 days of clean operation on Stalwart.
- **Same public surface during cutover.** `mail.antonshubin.com` and
  `mail.neatsoft.dev` keep resolving to the same IP; only the *answering*
  process changes. We use port offsets during the parallel run so both can
  answer simultaneously.
- **One stack to operate.** The end state has **one** mail process (Stalwart)
  instead of seven cooperating ones (`master`, `qmgr`, `smtpd`, `rspamd`,
  `dovecot`, `clamd`, `fail2ban-server`).

## 2. Why Stalwart (and JMAP) is better than the current stack

### 2.1 Operational footprint

| Concern                          | DMS (current)                                                       | Stalwart (target)                                  |
|----------------------------------|---------------------------------------------------------------------|----------------------------------------------------|
| Number of processes              | 7+ (`postfix/master`, `postfix/qmgr`, `postfix/smtpd`, `rspamd: main`, `rspamd: controller`, `rspamd: hs_helper`, `dovecot`, plus `fail2ban-server` and `clamd` if enabled) | **1** (Stalwart forks worker tokio tasks, but they're one binary) |
| RAM idle (current observed)      | ~500 MB                                                             | ~40–80 MB                                          |
| Disk footprint                   | 165 MB `mail-data` + 310 MB `mail-state` + 474 MB `mail-logs` = **~950 MB** | ~170 MB same data, no `mail-state` (SQLite replaces Redis + postfix queues + rspamd history) |
| Config files                     | `postfix-main.cf`, `dovecot.conf`, `rspamd/local.d/*.conf`, `fail2ban/jail.local`, OpenDKIM, plus all the DMS env vars → 4 different syntaxes (Postfix, Dovecot, Rspamd, jail.local) | **One TOML file** (`/opt/stalwart-mail/config.toml`) |
| Backup shape                     | Maildir + Redis dump + rspamd history + postfix queue               | SQLite single file + Maildir export                |
| Updates                          | Pull `docker-mailserver:latest`; risk of OpenDKIM/Rspamd version drift breaking DKIM | Single binary release with signed checksums        |
| Supply chain                     | 3 upstream projects (Docker Mailserver, Rspamd, OpenDKIM, Dovecot) + their patches | 1 upstream (Stalwart), single signed release       |

### 2.2 Mobile-first protocol

JMAP was designed *after* IMAP, fixing its mobile-hostile assumptions:

- **One TCP connection, multiplexed.** IMAP needs `IDLE` to get push and a
  second connection for "send message" while IDLE holds the first. JMAP
  pushes and sends both over the same request pipeline.
- **No connection-state machines to lose.** If the phone drops to LTE for 2
  seconds, IMAP falls out of `SELECTED` state and re-syncs the entire
  mailbox. JMAP tracks `sinceState` — a monotonic counter; resync only
  fetches what's new.
- **Server-side search.** IMAP's `SEARCH` downloads the result set; JMAP's
  `Filter` operator returns IDs only, then a single `getMailbox` call fetches
  the bodies. On 10k-message mailboxes this is 10× faster on slow LTE.
- **Push without polling.** JMAP `PushSubscription` over WebSocket — Stalwart
  pushes the moment a message lands. Battery-friendly: no `IDLE` socket kept
  awake.
- **Calendar + Contacts for free.** Stalwart speaks JMAP for mail,
  calendars, and contacts, so the same client configures all three. We
  currently have *no* CalDAV/CardDAV; this closes that gap.

### 2.3 Anti-abuse

DMS requires fail2ban + `nftables` because Postfix has no native rate
limiting per source IP. As we saw in commit `57cf70e`, that combo will ban
your own infrastructure IPs after one typo. Stalwart has:

- **Per-IP rate limit** (sliding window) for SMTP `RCPT TO` — default 100/hour.
- **Per-account rate limit** for IMAP `LOGIN` — default 5/minute, exponential
  back-off up to 1 hour.
- **Per-IP throttling** for JMAP — same algorithm as IMAP.
- **No silent global DROP.** When Stalwart blocks, it answers `421 4.7.28`
  with a `Retry-After` header, so a misconfigured legitimate client gets a
  fixable error, not a timeout. (See [§ 14](#14-should-you-message-hetzner).)

### 2.4 Cryptography and authenticity

- DKIM signing in Stalwart uses **ed25519 + RSA dual-sign** by default. DMS
  gives you RSA only unless you opt into Rspamd's experimental ed25519 path.
- ARC sealing is built-in. DMS depends on Rspamd's `arc` module which is
  on-by-default but invisible in the UI; you'd never know it broke.
- ACME (Let's Encrypt) is **native** in Stalwart; one `acme.*` block and the
  cert renews itself. DMS still expects you to `extract-certs.sh` into
  `/etc/letsencrypt/live/mail.<domain>` and reload Postfix — that's the
  `extract-certs.sh` file in this repo.

## 3. Client compatibility — Android + Fedora KDE

### 3.1 Android

| Client          | JMAP | IMAP fallback | Free | F-Droid | Notes |
|-----------------|------|---------------|------|---------|-------|
| **FairEmail**   | ✅ (Pro)  | ✅     | Base / Pro split | ✅ | Best UX, supports JMAP mail + calendars via JMAP. Pro ~€5 one-time. |
| **JmapMail**    | ✅    | ✅     | ✅    | ✅ | Pure JMAP, minimal UI, F-Droid only. Good as secondary. |
| **aJMAP**       | ✅    | ✅     | ✅    | ✅ | jmap-cli compatible. Less polished than FairEmail. |
| K-9 Mail        | ❌    | ✅     | ✅    | ✅ | Not recommended post-migration — IMAP-only. |
| Gmail app       | ❌    | ✅     | ✅    | ✅ | Won't see folders properly; last resort. |

**Recommendation:** install **FairEmail** on the phone. Point it at the
Stalwart discovery URL (`https://mail.antonshubin.com/.well-known/jmap`),
log in once. Set push on for INBOX.

### 3.2 Fedora KDE (laptop + mini-PC)

| Client          | JMAP | IMAP fallback | Native Linux | Notes |
|-----------------|------|---------------|--------------|-------|
| **Thunderbird** | ❌ (Mozilla bug 1892808, no ETA) | ✅ | ✅ | Will continue to work via IMAP/SMTP. Folder pane + message filters unchanged. |
| Kmail           | ❌    | ✅     | ✅     | Same. |
| Evolution       | ❌    | ✅     | ✅     | GNOME. |
| Stalwart Webmail| ✅    | ✅     | Browser    | Replaces SnappyMail. Light SPA, no JavaScript framework bloat. |

**Recommendation:** keep using **Thunderbird** with IMAP/SMTP for the laptop
and mini-PC during and after the migration. The user-visible experience on
Thunderbird is identical. The phone is where JMAP wins big.

If you want to validate JMAP end-to-end from a desktop browser, point a tab
at `https://mail.antonshubin.com/webmail` (Stalwart's built-in webmail,
replaces `https://webmail.antonshubin.com` from SnappyMail).

## 4. Pre-migration inventory

Snapshot these on `cloudlab` *before* any change. All paths are on
`cloudlab` unless noted.

```
# Account & alias definitions (DMS source of truth)
$VOLUMES_PATH/mailserver/config/postfix-accounts.cf       # 3 accounts
$VOLUMES_PATH/mailserver/config/postfix-virtual.cf        # 7 aliases + 2 catch-alls + sender-login
$VOLUMES_PATH/mailserver/config/postfix-send-access.cf    # sender ACL
$VOLUMES_PATH/mailserver/config/dovecot-quotas.cf         # empty in our case

# DKIM key material (signed DNS records depend on these byte-for-byte)
$VOLUMES_PATH/mailserver/config/rspamd/dkim/
  rsa-2048-mail-antonshubin.com.private.txt               # 1704 bytes, RSA 2048
  rsa-2048-mail-antonshubin.com.public.dns.txt            # published TXT record
  rsa-2048-mail-antonshubin.com.public.txt
  rsa-2048-mail-neatsoft.dev.private.txt                   # ditto
  rsa-2048-mail-neatsoft.dev.public.dns.txt
  rsa-2048-mail-neatsoft.dev.public.txt

# Mailboxes (Maildir format — same layout Stalwart expects)
$VOLUMES_PATH/mailserver/mail-data/<domain>/<user>/{cur,new,tmp}

# Spam training data (Rspamd Bayes)
$VOLUMES_PATH/mailserver/mail-state/lib-rspamd/

# TLS certs (Let's Encrypt via Traefik, copied in via extract-certs.sh)
$VOLUMES_PATH/mailserver/config/ssl/

# Fail2ban jail (already addressed in 57cf70e — keep the file for history)
$VOLUMES_PATH/mailserver/config/fail2ban/jail.local
```

Total to migrate: **3 accounts, 7 aliases, 2 catch-alls, 1 sender-login ACL,
2 DKIM keypairs, ~165 MB Maildir data**.

## 5. Migration phases

```
       ┌───────────────┐
       │  Phase 0      │  Snapshot everything (off-host backup)
       └──────┬────────┘
              ▼
       ┌───────────────┐
       │  Phase 1      │  Deploy Stalwart on ports 25/465/587/993/7990 *behind* DMS
       │               │  (DMS keeps answering; Stalwart is silent)
       └──────┬────────┘
              ▼
       ┌───────────────┐
       │  Phase 2      │  Import accounts, aliases, DKIM, Maildir
       │               │  Stalwart answers on its own ports; DMS still primary
       └──────┬────────┘
              ▼
       ┌───────────────┐
       │  Phase 3      │  Validate IMAP/SMTP from Thunderbird (off-peak window)
       └──────┬────────┘
              ▼
       ┌───────────────┐
       │  Phase 4      │  Cutover: repoint Traefik mail.* routes to Stalwart,
       │               │  swap DNS if needed (no DNS change required — same IP)
       └──────┬────────┘
              ▼
       ┌───────────────┐
       │  Phase 5      │  Decommission DMS, prune volumes, retire extract-certs.sh
       └───────────────┘
```

End-to-end effort estimate: **3–4 hours** of focused work, plus 30 days of
shadow run between phases 3 and 5.

## 6. Phase 0 — Backup everything (no change)

DMS already has a backup via `stacks/mailserver/backup.ts`. Trigger it once
before starting and verify the artifact is restorable.

```bash
# Trigger
deno task backup cloudlab mailserver

# Pull the artifact off-cloudlab and verify checksum
scp cloudlab:~/cloudlab/backups/mailserver-*.tar.zst .
zstd -dc mailserver-*.tar.zst | tar tf - | head -30   # smoke test
```

Also snapshot the live volumes to a sibling path as belt-and-suspenders:

```bash
ssh cloudlab 'sudo -u spy4x cp -a $PATH_APPS/.volumes/mailserver \
                              $PATH_APPS/.volumes/mailserver.before-stalwart'
```

We use the sibling copy in Phase 5 to prove we haven't lost anything.

## 7. Phase 1 — Deploy Stalwart alongside DMS (parallel run)

**Stack file:** `stacks/stalwart/compose.yml` (new).

Stalwart listens on the same ports as DMS, but we shift the *container-side*
ports and use `network_mode: host` only during testing. During Phase 1 we
keep DMS on `25/465/587/993` and bind Stalwart to:

- `2525` (SMTP submission, alternate)
- `7993` (IMAPS, alternate)
- `7990` (JMAP/HTTPS, alternate — used by FairEmail discovery)
- `11335` (HTTP admin, alternate)

This way both processes can run simultaneously without conflicting. Stalwart
*imports from DMS via filesystem only* during this phase — no real mail
flows yet.

```yaml
# stacks/stalwart/compose.yml
networks:
  proxy:
    external: true

services:
  stalwart:
    image: stalwartlabs/mail-server:latest
    container_name: hl-stalwart
    hostname: mail
    domainname: ${DOMAIN}
    restart: unless-stopped
    # No host-port mapping during parallel run — Traefik will route by Host().
    volumes:
      - ${VOLUMES_PATH}/stalwart/data:/opt/stalwart-mail/data:z
      - ${VOLUMES_PATH}/stalwart/config:/opt/stalwart-mail/config:z
      # Read-only access to DMS Maildir for the import step
      - ${VOLUMES_PATH}/mailserver/mail-data:/import/mail-data:ro,z
      - /etc/localtime:/etc/localtime:ro,z
    environment:
      - DOMAIN=${DOMAIN}
      - HOSTNAME=mail
    networks:
      - proxy
    labels:
      # Disabled until Phase 4 (cutover). During parallel run we hit the
      # admin port directly via SSH tunnel (tunnel was removed; Stalwart runs on cloud behind Traefik).
      - "traefik.enable=false"
    healthcheck:
      test: ["CMD", "curl", "-fk", "https://127.0.0.1:7990/.well-known/jmap"]
      interval: 30s
      timeout: 5s
      retries: 3
```

## 8. Phase 2 — Import accounts, aliases, DKIM keys, Maildir

### 8.1 Accounts

DMS stores accounts in `/tmp/docker-mailserver/postfix-accounts.cf`:

```
anton@antonshubin.com|{SHA512-CRYPT}$6$f7FQ5Z083zSCcbKq$K4nwTTU...
noreply@antonshubin.com|{SHA512-CRYPT}$6$65a1MThWoXnUVA89$sPqnnbD...
anton@neatsoft.dev|{SHA512-CRYPT}$6$JDj/P3mtoeqh/au4$xryDblCFRX...
```

Stalwart supports the same hash format out of the box
(`argon2id` is the default, but `sha512-crypt` is accepted via the
`password-algorithm` config option). Translation:

```toml
# stacks/stalwart/config/directory.toml (mounted at /opt/stalwart-mail/config)
[directory]
type = "sql"
store = "sqlite"

[directory.sql]
url = "sqlite://data/directory.sqlite"

[[directory.principals]]
name = "anton@antonshubin.com"
type = "individual"
secrets = ["$6$f7FQ5Z083zSCcbKq$K4nwTTUleVwDhSdajl1mBNkMHtiUVc7raliYvbyeFnon.Y8SXgFAVhQEHbr4DkhUPpTrg/PR22dL6Pcw0J6RT1"]
description = "Anton Shubin"

[[directory.principals]]
name = "anton@neatsoft.dev"
secrets = ["$6$JDj/P3mtoeqh/au4$xryDblCFRX15qgPnNIjW.tfoDIQPFtnGb3zp2kdSMDvR3LzdK6FaEfqVRByV5MbqSSQ2vE.pAU5q6rDb0q87X1"]
description = "Anton Shubin (Neatsoft)"

[[directory.principals]]
name = "noreply@antonshubin.com"
secrets = ["$6$65a1MThWoXnUVA89$sPqnnbDtX.Zz88rq2FS0mh31z3jM68uW6x6pUtKBnsRlfoag4TtZRGTW4wLDPDvJEBhRTxLn.5//A0M1vb2L01"]
description = "No-reply sender"
```

Because Stalwart accepts SHA512-CRYPT, the existing passwords keep working
without notifying the user of a reset.

### 8.2 Aliases

DMS virtual file:

```
postmaster@antonshubin.com anton@antonshubin.com
abuse@antonshubin.com anton@antonshubin.com
hostmaster@antonshubin.com anton@antonshubin.com
webmaster@antonshubin.com anton@antonshubin.com
admin@antonshubin.com anton@antonshubin.com
info@antonshubin.com anton@antonshubin.com
support@antonshubin.com anton@antonshubin.com
hello@antonshubin.com anton@antonshubin.com
@neatsoft.dev anton@neatsoft.dev
@antonshubin.com anton@antonshubin.com
```

Stalwart equivalent in `directory.toml`:

```toml
[[directory.principals]]
name = "postmaster@antonshubin.com"
type = "group"
members = ["anton@antonshubin.com"]
# (repeat for abuse, hostmaster, webmaster, admin, info, support, hello)

[[directory.principals]]
name = "antonshubin.com"
type = "list"
members = ["anton@antonshubin.com"]

[[directory.principals]]
name = "neatsoft.dev"
type = "list"
members = ["anton@neatsoft.dev"]
```

Sender-login ACL (`postfix-send-access.cf`):

```
anton@neatsoft.dev anton@antonshubin.com,anton@neatsoft.dev
```

Becomes a Stalwart `authenticate-as` rule:

```toml
[auth.rules]
"anton@neatsoft.dev" = ["anton@antonshubin.com", "anton@neatsoft.dev"]
```

### 8.3 DKIM

DMS generates `rsa-2048-mail-<domain>.private.txt` keys with selector `mail`.
Stalwart expects PEM PKCS#8 keys at `/opt/stalwart-mail/etc/dkim/`. The DMS
Rspamd key file is already PEM, so we can drop it in directly:

```bash
ssh cloudlab 'mkdir -p $PATH_APPS/.volumes/stalwart/config/etc/dkim
  cp $PATH_APPS/.volumes/mailserver/config/rspamd/dkim/rsa-2048-mail-antonshubin.com.private.txt \
     $PATH_APPS/.volumes/stalwart/config/etc/dkim/antonshubin.com.key
  cp $PATH_APPS/.volumes/mailserver/config/rspamd/dkim/rsa-2048-mail-neatsoft.dev.private.txt \
     $PATH_APPS/.volumes/stalwart/config/etc/dkim/neatsoft.dev.key'
```

Then in `directory.toml`:

```toml
[queue.dkim]
sign = ["antonshubin.com", "neatsoft.dev"]

[[queue.dkim.signers]]
id = "antonshubin.com"
domain = "antonshubin.com"
selector = "mail"            # SAME selector as DMS — DNS records unchanged
private-key = "file://etc/dkim/antonshubin.com.key"
# algorithm is RSA-SHA256 by default (matches DMS)

[[queue.dkim.signers]]
id = "neatsoft.dev"
domain = "neatsoft.dev"
selector = "mail"
private-key = "file://etc/dkim/neatsoft.dev.key"
```

**Do NOT regenerate the DKIM keys.** The published `mail._domainkey.*` TXT
records at the DNS provider reference the public key. If we change the
private key, every mail we send will fail DMARC until the DNS record is
updated and TTL expires (often 1 hour; could be 24 hours).

### 8.4 Maildir import

DMS stores mail in `/var/mail/<domain>/<user>/Maildir/` (Maildir++). Stalwart
imports the same directory tree directly. We point Stalwart at the DMS
volume read-only during import, then cut over:

```bash
ssh cloudlab 'docker exec hl-stalwart stalwart-mail import \
  --server jmap --account anton@antonshubin.com \
  --source /import/mail-data/antonshubin.com/anton/Maildir'
```

Repeat for `noreply@antonshubin.com` and `anton@neatsoft.dev`. Stalwart
preserves `cur/`, `new/`, flags (`S=seen`, `F=flagged`, `R=answered`), and
INBOX sub-folder layout (Sent, Drafts, Junk, Trash are auto-detected by
folder name).

**Verification after import:**

```bash
# Inside Stalwart, compare message counts:
docker exec hl-stalwart stalwart-mail stats --account anton@antonshubin.com
# Should equal the DMS count:
ssh cloudlab "find $PATH_APPS/.volumes/mailserver/mail-data/antonshubin.com/anton/Maildir \
              -type f | wc -l"
```

### 8.5 Spam training data

Skip for now. Rspamd's Bayes database uses Redis and a custom format; Stalwart
uses an internal Bayesian classifier that trains from scratch in ~2 weeks.
After 2 weeks of production use, retrain manually by:

1. Marking spam in FairEmail (long-press → "Move to Junk").
2. Running `docker exec hl-stalwart stalwart-mail train --account ...`

## 9. Phase 3 — Validate IMAP/SMTP from Thunderbird

**On Fedora KDE laptop + mini-PC** (off-peak window, e.g. weekend morning):

1. **Add a second account in Thunderbird** — do *not* modify the existing
   one yet. Settings:
   - IMAP: `mail.antonshubin.com:7993`, SSL/TLS, normal password, username
     `anton@antonshubin.com`
   - SMTP: `mail.antonshubin.com:2525`, STARTTLS, normal password, username
     `anton@antonshubin.com`
2. Verify folder list matches DMS exactly (INBOX, Sent, Drafts, Junk,
   Trash, plus custom folders).
3. Send a test message *to yourself* and verify DKIM passes:

   ```bash
   # Verify DKIM signature on outbound
   docker exec hl-stalwart grep "DKIM-Signature" \
     /opt/stalwart-mail/data/queue/sent/$(ls -t ...) | head -1
   # d=antonshubin.com s=mail (same as before)
   ```
4. Receive a test message (from another account you control) and check
   headers for `ARC-Authentication-Results: ... dkim=pass`.

If everything matches: proceed to Phase 4.

## 10. Phase 4 — Cutover

**This step is the only one that affects production.** Schedule it during
the lowest-traffic window (Sunday 04:00 local).

1. Stop accepting new SMTP on DMS by setting Postfix to `defer_all`:

   ```bash
   ssh cloudlab 'docker exec hl-mailserver postconf -e defer_transports=smtp'
   ```

   Inbound mail now queues at the sender; we have ~10 minutes before
   timeouts start.

2. Repoint Traefik mail.* routes from DMS to Stalwart:

   ```yaml
   # stacks/mailserver/compose.yml — change Traefik labels to hl-stalwart
   # OR set Traefik to route by container label; Stalwart labels are added
   # to stacks/stalwart/compose.yml at this point.
   ```

   Concretely: edit `stacks/mailserver/compose.yml` to remove Traefik
   labels for the mailserver service and edit `stacks/stalwart/compose.yml`
   to add them (with `traefik.enable=true`).

3. Restart Traefik (it auto-reloads labels every ~30 s, but a forced
   `docker restart hl-traefik` is faster):

   ```bash
   ssh cloudlab 'docker restart hl-traefik'
   ```

4. Verify from external:

   ```bash
   openssl s_client -connect mail.antonshubin.com:993 -servername mail.antonshubin.com </dev/null \
     | grep "CONNECTED"
   curl -fsS https://mail.antonshubin.com/.well-known/jmap | jq '.capabilities | keys'
   ```

   JMAP discovery should return `["urn:ietf:params:jmap:core",
   "urn:ietf:params:jmap:mail", ...]`.

5. Release the Postfix queue:

   ```bash
   ssh cloudlab 'docker exec hl-mailserver postsuper -r ALL; \
     docker exec hl-mailserver postconf -e defer_transports='
   ```

   Any mail that arrived between steps 1 and 4 is now redelivered through
   Stalwart via a one-shot `stalwart-mail deliver-from-postfix-spool`
   helper (provided by Stalwart).

6. Update DNS — **not required** if `mail.antonshubin.com` already resolves
   to `23.88.101.28` (it does). The same IP, same hostname, different
   process. No TTL propagation delay.

7. Update SnappyMail replacement URL:

   - Retire `https://webmail.antonshubin.com` (SnappyMail).
   - Publish `https://webmail.antonshubin.com → Stalwart built-in webmail`
     via Traefik label change on the stalwart stack.

8. Update email-mcp config on homelab:

   The template (`config.toml.template`) already points directly to Stalwart
   (`mail.antonshubin.com:993/587`). Re-deploy to regenerate `config.toml`:

   ```bash
   deno task deploy home email-mcp
   ```

   The `before.deploy.ts` script renders `config.toml` from the template and
   replaces `${EMAIL_MCP_*}` env vars with values from `servers/home/.env`.

   **Note:** The old SSH tunnel (`cloud-tunnel`) that forwarded ports 1993/1587
   has been removed — it was a Hetzner firewall workaround that is no longer
   needed. All services connect directly to `mail.antonshubin.com:993/587`.

## 11. Phase 5 — Decommission DMS

After 30 days of clean Stalwart operation:

1. Stop the DMS container:

   ```bash
   ssh cloudlab 'docker stop hl-mailserver && docker rm hl-mailserver'
   ```

2. Remove the DMS volumes (after verifying the sibling snapshot is fine):

   ```bash
   ssh cloudlab 'rm -rf $PATH_APPS/.volumes/mailserver'
   ```

3. Remove the DMS stack:

   ```bash
   rm -rf stacks/mailserver
   ```

4. Remove the `extract-certs.sh` flow — Stalwart's built-in ACME replaces
   it. Traefik labels on `hl-mail-cert-helper` go away in the same commit.

5. Remove the SnappyMail stack:

   ```bash
   rm -rf stacks/snappymail
   # SnappyMail is replaced by Stalwart's built-in webmail (apps/webmail)
   ```

6. Remove the fail2ban jail.local mount (Stalwart has its own rate limiter):

   ```bash
   rm -rf stacks/mailserver/fail2ban/
   ```

7. Update `backup.ts` for the new volumes shape. The Stalwart stack is much
   simpler:

   ```ts
   // stacks/stalwart/backup.ts
   sourcePaths: [
     `${VOLUMES_PATH}/stalwart/data`,         // SQLite + Maildir import staging
   ],
   containers: { stop: "default" },
   ```

8. Update `README.md` and `docs/architecture.md` to reflect the new stack.

9. Cancel the Hetzner firewall rule changes we made for DMS if no other
   service uses them. (See [§ 14](#14-should-you-message-hetzner).)

## 12. PR checklist

This PR (current `feat/stalwart-migration` branch) ships **only the
planning document**. Nothing is deployed yet. The PR body should be:

```
## What

Planning document for migrating the personal mail server from
docker-mailserver (DMS) to Stalwart Mail. Zero code changes in this PR.

## Why

- DMS is a 7-process stack with a known fail2ban landmine (see commit 57cf70e).
- Stalwart is a single Rust binary with native JMAP — better mobile UX,
  lower RAM, no fail2ban surface.
- SnappyMail (current webmail) does not support JMAP. Stalwart's built-in
  webmail does.

## What this PR contains

- docs/migrate-from-docker-mailserver-to-stalwart.md — full plan, 14 sections
- (nothing else — no new stacks, no live changes)

## What this PR does NOT contain

- New stack file (stacks/stalwart/) — proposed for a follow-up PR after
  the plan is reviewed and signed off
- Any live deployment
- DNS changes
- DKIM rotation (we keep DMS keys to avoid DNS TTL pain)

## Risks

- Low risk — documentation only.
- Open question: do we want to remove DMS in this PR cycle or a separate one?
  (Tracked in § 13.)
```

A separate `feat/stalwart-deploy` PR will add the actual stack file once
the plan is approved.

## 13. Open questions / decisions

| # | Question | Default answer |
|---|----------|----------------|
| 1 | Webmail URL: keep `webmail.antonshubin.com` or move to `mail.antonshubin.com/webmail`? | Keep `webmail.antonshubin.com` (no client retraining). |
| 2 | Stalwart store: SQLite or FoundationDB? | SQLite. We're at 1 user, <1 GB mailbox total. FoundationDB is overkill. |
| 3 | Stalwart webmail: enable built-in, or run a separate SPA? | Built-in. Lighter, no extra container. |
| 4 | When to actually retire DMS? | 30 days after Phase 4 cutover with no rollback. |
| 5 | Do we keep DMS keys for trust continuity? | Yes — do **not** rotate DKIM. Keep the selector `mail`. |
| 6 | Do we re-train Bayes from scratch? | Yes. Rspamd's DB is non-portable. 2 weeks of normal traffic retrains it. |
| 7 | SnappyMail backup of already-imported identities? | Wipe on Phase 4 cutover; Stalwart admin takes over. |
| 8 | Should we message Hetzner about port 25 / abuse prevention? | See [§ 14](#14-should-you-message-hetzner). |

## 14. Should you message Hetzner?

**Short answer: only if you want to send unauthenticated outbound SMTP
from a future second server. Not for this migration.**

Hetzner has historically required an opt-in to send outbound port 25
traffic from new cloud servers, to prevent spammers from spinning up
cheap VMs to relay spam. **Incoming** port 25 is unaffected, and
**incoming 465/587/993** are unaffected — those are the ports we actually
use. Confirming from the [Hetzner Cloud docs](https://docs.hetzner.com/cloud/networks/server-network-rules):

> "Outgoing connections to port 25 (SMTP) are blocked by default. To
> enable them, please contact our support."

Our use case (receiving mail, sending from authenticated submission on
465/587) **does not require outgoing port 25**. Stalwart's queue routes
all outbound submission via 465/587 just like DMS does, and Hetzner
allows that. The user does not need to contact support for this migration.

If, in a later phase, we want to host *another* tenant on the same server
who would like to relay outgoing mail from non-submission ports (rare,
usually legacy scripts), then we open a ticket. Until then: no action.

## Appendix A — Side-by-side feature matrix

| Capability                          | DMS today                      | Stalwart target                |
|-------------------------------------|--------------------------------|--------------------------------|
| SMTP submission (587/465)           | ✅ via Rspamd + Postfix        | ✅ built-in                    |
| SMTP inbound (25)                   | ✅ via Postfix                 | ✅ built-in                    |
| IMAP4 (993)                         | ✅ via Dovecot                 | ✅ built-in                    |
| ManageSieve                         | ✅ via Pigeonhole              | ✅ built-in                    |
| JMAP (RFC 8620/8621)                | ❌                             | ✅ built-in                    |
| CalDAV                              | ❌                             | ✅ via JMAP                    |
| CardDAV                             | ❌                             | ✅ via JMAP                    |
| Webmail                             | ✅ SnappyMail (separate)       | ✅ built-in                    |
| Push (mobile)                       | ❌ IMAP-IDLE only              | ✅ JMAP Push over WebSocket    |
| DKIM signing                        | ✅ via Rspamd                  | ✅ built-in (ed25519 + RSA)    |
| ARC sealing                         | ✅ via Rspamd (silent)         | ✅ built-in, visible in UI     |
| DMARC reporting                     | ❌                             | ✅ built-in                    |
| SPF                                 | ✅ via Postfix                 | ✅ built-in                    |
| Bayesian spam                       | ✅ via Rspamd + Redis          | ✅ built-in, no Redis          |
| DNSBL                               | ✅ via Rspamd                  | ✅ built-in                    |
| Per-IP rate limit                   | ❌ (fail2ban required)         | ✅ built-in                    |
| Per-account rate limit              | ❌                             | ✅ built-in                    |
| Fail2ban equivalent                 | ⚠️ Required                    | ✅ Built-in, configurable      |
| TLS (Let's Encrypt)                 | ⚠️ via Traefik + extract-certs | ✅ built-in ACME               |
| Web admin UI                        | ❌ (SnappyMail admin only)      | ✅ built-in                    |
| Single config file                  | ❌ (4+ files)                  | ✅ one TOML                    |
| Single process                      | ❌ (7+)                        | ✅ one Rust binary             |
| RAM usage idle                      | ~500 MB                        | ~40-80 MB                      |
| Disk (current observed)             | ~950 MB                        | ~170 MB                        |
| Mobile-friendly                     | ⚠️ IMAP only                   | ✅ JMAP native                 |

---

*Drafted as part of the `feat/stalwart-migration` worktree, based on
commit `57cf70e` (fail2ban whitelist fix). See commit log for the
unban + rename history.*
