# Auth Infrastructure Plan — Authelia Deepening

Current state: Authentik → Authelia migrated. Forward-auth working for
transmission, akaunting, monica. TOTP configured (CLI). Notifier uses
filesystem (SMTP pending). ~15 stacks still use basic auth (`auth`).

Goal: **2FA everywhere. One password + TOTP for all services.**
No OIDC for now (too complex, revisit later).

---

## Why 2FA for everything, not just admin?

Same threat model for all internal services:

- A leaked password exposes torrents, invoices, notes, tools — all
  personal data
- TOTP is free (Bitwarden generates it), friction is one extra field
- "Remember device" cookie avoids re-prompt on the same browser
- No reason to treat `torrents` as less sensitive than `grafana`

The only exception: services with their own auth that's stronger or
incompatible with forward-auth (see below).

---

## Architecture

```
User ──► Traefik ──► Authelia (forward-auth, 2FA) ──► Backend
                ▲
                └── 401 → redirect to auth.antonshubin.com
                      ↓ password + TOTP → session cookie
                      ↓ redirect back to original URL
```

Simple. No OIDC callbacks, no token exchange, no app configuration.
Every HTTP service works, no exceptions.

---

## Phase 1 — Switch basic auth → Authelia (2FA)

### Affected stacks

Change `middlewares=auth,...` → `middlewares=authelia@file,...`

| Stack   | Domain            | Notes                                      |
| ------- | ----------------- | ------------------------------------------ |
| metube  | metube.${DOMAIN}  | No own auth                                |
| ollama  | ollama.${DOMAIN}  | No own auth                                |
| traggo  | time.${DOMAIN}    | Has own auth (weak)                        |
| grafana | metrics.${DOMAIN} | Has own auth, can trust Remote-User header |

| mailserver | rspamd.${DOMAIN}     | No own web auth                            |
| opencode-web     | code.${DOMAIN} | Has API key auth, UI needs protection |
| traefik | proxy-home.${DOMAIN} | Admin panel |

**Complex middleware chains — edit carefully:**

```yaml
# opencode-web:
  middlewares=authelia@file,robots-deny@file

# grafana:
  middlewares=auth,robots-deny@file
# → middlewares=authelia@file,robots-deny@file

# traefik (inline basic auth on compose line 74):
  - "traefik.http.routers.hl-traefik.middlewares=auth"
  # Remove inline auth, add authelia@file instead
  # Also need a separate middleware label? Check compose first.
```

### Already on Authelia — bump to 2FA

These already have `authelia@file`, just change policy:

| Stack        | Domain             | Current    | New        |
| ------------ | ------------------ | ---------- | ---------- |
| transmission | torrents.${DOMAIN} | one_factor | two_factor |
| akaunting    | invoices.${DOMAIN} | one_factor | two_factor |
| monica       | crm.${DOMAIN}      | one_factor | two_factor |

---

## Services NOT to cover with Authelia

These stay `bypass` (no Authelia in front):

| Service              | Domain              | Reason                                                        |
| -------------------- | ------------------- | ------------------------------------------------------------- |
| antonshubin.com      | antonshubin.com     | Public website                                                |
| neatsoft.dev         | neatsoft.dev        | Public website                                                |
| auth.antonshubin.com | auth.${DOMAIN}      | Can't auth-lock the auth page                                 |
| **Vaultwarden**      | passwords.${DOMAIN} | Master password + own 2FA. Mobile app can't do browser auth   |
| **Immich**           | photos.${DOMAIN}    | Own auth + API keys. Mobile app breaks with forward-auth      |
| **Jellyfin**         | movies.${DOMAIN}    | Own auth. TV/mobile clients can't forward-auth                |
| **Gitea**            | git.${DOMAIN}       | Own auth + SSH keys + git CLI. Forward-auth breaks `git push` |
| **Woodpecker**       | ci.${DOMAIN}        | GitHub OAuth only. No password to put in Authelia             |
| **Plausible**        | analytics.${DOMAIN} | Own invite-only auth                                          |
| **Umami**            | stats.${DOMAIN}     | Own auth                                                      |
| **Stalwart**         | stalwart.${DOMAIN}  | Admin password, already behind wireguard                      |
| **Paperless-ngx**    | docs.${DOMAIN}      | Own auth + API tokens for automation                          |

### What about Grafana?

Grafana has own auth BUT can trust the `Remote-User` header
that Traefik injects after Authelia passes the request:

**Grafana** — add these env vars to auto-login:

```yaml
- GF_AUTH_PROXY_ENABLED=true
- GF_AUTH_PROXY_HEADER_NAME=X-Forwarded-User
- GF_AUTH_PROXY_HEADER_PROPERTY=username
- GF_AUTH_PROXY_AUTO_SIGN_UP=true
- GF_AUTH_PROXY_WHITELIST=*
```

This way: visit metrics.${DOMAIN} → Authelia (2FA) → Grafana
auto-logged-in. No second login.

---

## Phase 2 — Update Access Control

Replace current `configuration.yml` rules with:

```yaml
access_control:
  default_policy: deny
  rules:
    # Public — bypass
    - domain: "antonshubin.com"
      policy: bypass
    - domain: "auth.antonshubin.com"
      policy: bypass
    - domain: "neatsoft.dev"
      policy: bypass
    - domain: "www.neatsoft.dev"
      policy: bypass

    # Strong own auth — bypass (would break app functionality)
    - domain: "passwords.antonshubin.com"
      policy: bypass
    - domain: "photos.antonshubin.com"
      policy: bypass
    - domain: "movies.antonshubin.com"
      policy: bypass
    - domain: "git.antonshubin.com"
      policy: bypass
    - domain: "ci.antonshubin.com"
      policy: bypass
    - domain: "analytics.antonshubin.com"
      policy: bypass
    - domain: "stats.antonshubin.com"
      policy: bypass
    - domain: "stalwart.antonshubin.com"
      policy: bypass
    - domain: "docs.antonshubin.com"
      policy: bypass

    # Everything else — 2FA required
    - domain: "torrents.antonshubin.com"
      policy: two_factor
    - domain: "invoices.antonshubin.com"
      policy: two_factor
    - domain: "crm.antonshubin.com"
      policy: two_factor
    - domain: "metube.antonshubin.com"
      policy: two_factor
    - domain: "ollama.antonshubin.com"
      policy: two_factor
    - domain: "time.antonshubin.com"
      policy: two_factor
    - domain: "rspamd.antonshubin.com"
      policy: two_factor
    - domain: "code.antonshubin.com"
      policy: two_factor
    - domain: "metrics.antonshubin.com"
      policy: two_factor
    - domain: "metrics-vm.antonshubin.com"
      policy: two_factor
    - domain: "proxy-home.antonshubin.com"
      policy: two_factor
```

### Execution

```bash
# 1. Update configuration.yml, then deploy authelia
deno task deploy home authelia

# 2. Switch stacks one by one, deploy after each
deno task deploy home metube
deno task deploy home ollama
deno task deploy home traggo
deno task deploy home grafana
deno task deploy home victoria-metrics
deno task deploy home mailserver   # rspamd
deno task deploy home opencode-web
deno task deploy home traefik

# 3. After each: visit domain → confirm redirect to Authelia
#    → log in with password + TOTP → confirm access
```

---

## SMTP Notifier

Currently filesystem (`/data/notifications.yml`). Identity verification
codes are extracted via:

```bash
ssh homelab 'docker run --rm -v ~/ssd-2tb/apps/.volumes/authelia/data:/data \
  alpine grep -A1 "one-time code\|following one-time" /data/notifications.yml \
  2>/dev/null | tail -1'
```

To get codes via email instead, switch to SMTP. Authelia v4.39
can't resolve `${VAR}` in typed fields (port numbers, addresses).
Workaround: bake SMTP values directly into the YAML (the config is
encrypted in `.env.age` anyway):

```yaml
notifier:
  smtp:
    address: smtp://mail.antonshubin.com:587
    username: noreply@antonshubin.com
    password: YOUR_SMTP_PASSWORD_HERE
    sender: Authelia <noreply@antonshubin.com>
```

---

## Gatus Monitoring Problem

302 from Authelia means "auth layer works" but doesn't confirm the
backend is actually up. Example: transmission could be crashed, but
gatus sees 302 → thinks everything is fine.

### Option A — Accept 302 as "routing works"

Best effort. Add a separate healthcheck for authelia itself:

Add to `servers/cloud/configs/gatus.yml`:

```yaml
- name: Authelia
  group: home
  url: "https://auth.${DOMAIN}"
  interval: 1m
  conditions:
    - "[STATUS] == 200"
  alerts:
    - type: ntfy
```

And keep existing endpoint checks with 200/302 condition.

### Option B — Bypass path per service

Add a health path that bypasses auth:

```yaml
access_control:
  rules:
    # Monitoring bypass — always allow /health
    - domain: "torrents.antonshubin.com"
      resources:
        - "^/health$"
      policy: bypass
```

Gatus hits `https://torrents.antonshubin.com/health` without auth.
Requires the backend to have a `/health` endpoint.

### Option C — Basic auth monitoring via Authelia

Use `/api/verify?auth=basic` with a dedicated monitoring user.
Gatus sends:

```yaml
headers:
  Authorization: Basic ${AUTHELIA_MONITOR_BASE64}
```

Create user `monitor` in `users.yml` with a separate password.
Base64-encode `monitor:password` and store as env var.

**Downside:** failed attempts from this user also trigger regulation
bans. Mitigation: set `max_retries: 100` or use a very strong
password that won't be bruteforced.

### Recommendation

Start with **Option A** (simplest). Add option C later if you want
true end-to-end monitoring. The 302 DOES confirm the backend is
reachable at the TCP level — if the container were fully down,
Traefik would return 502/503, not 302.

---

## Env Vars

In `.env` + `.env.example` (`#region Authelia`):

```bash
AUTHELIA_SESSION_SECRET=<hex>
```

Pass to authelia container in `stacks/authelia/compose.yml`:

```yaml
environment:
  - TZ=${TIMEZONE}
  - AUTHELIA_SESSION_SECRET=${AUTHELIA_SESSION_SECRET}
```

---
