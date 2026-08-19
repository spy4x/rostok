# Move Authelia from home → cloud

**Status:** Proposal — nothing executed. Written 2026-08-19 while adding
Authelia in front of the home Syncthing GUI (#138), which surfaced the
question of how to protect cloud-side services the same way.

## 0. The problem

Authelia runs on **home** only. `servers/cloud/config.json` and
`servers/offsite/config.json` have no `authelia` entry, so every service on
those hosts is either behind its own login or behind nothing at all.

This came up concretely with Syncthing: it deploys to all three servers from
one shared `stacks/syncthing/compose.yml`, so the `authelia@file` middleware
could not go there — it would be an unresolvable reference on cloud and
offsite and would break the router. The middleware had to go in
`servers/home/compose-override/syncthing.yml` instead, protecting exactly one
of the three GUIs.

AGENTS.md's rule — *"if a service stores personal data or gives access to
infrastructure, protect it"* — is currently only enforceable on home.

## 1. Why move rather than add a second instance

A second Authelia on cloud fails on the session cookie, not on resources.
`servers/home/configs/authelia/configuration.yml` scopes the cookie to the
whole apex:

```yaml
session:
  cookies:
    - domain: "antonshubin.com"
      authelia_url: https://auth.antonshubin.com
```

One cookie domain can only have one `authelia_url`, and two instances would
have different `session.secret` and different `storage.encryption_key`. A
cookie minted by one would not validate against the other. Making it work
means splitting the cookie scope (e.g. `cloud.antonshubin.com`), which means
two logins, two TOTP enrolments, and two user databases to keep in sync.

Pointing cloud's Traefik at home's Authelia has a worse problem — see §2.

## 2. Direction matters: cloud is the stable host

| | home (GMKTec K11) | cloud (Hetzner VPS) |
|---|---|---|
| Address | no static IP, behind Pangolin | static `23.88.101.28` |
| Uptime at time of writing | portable, moves with you | 43 days |
| Serves the apex | no (as of #135) | yes |
| Role | workstation-ish, being migrated | always-on |

`auth.antonshubin.com` currently resolves to `165.173.1.38` (home). Any
cloud service using forwardAuth against that would go **down with home** —
a laptop-class box with no static IP would gate access to the always-on
server. That is backwards.

Moving Authelia to cloud inverts it correctly: home depends on cloud, which
is the direction every other dependency already runs (backups replicate to
cloud, Pangolin's server side is on cloud).

## 3. Capacity — measured, not estimated

Authelia is small. Measured on home:

```
hl-authelia    30.4MiB / 256MiB   11.87%
```

plus `hl-authelia-redis` (limit 64M, a few MB in practice).

Cloud at the time of writing:

```
              total  used  free  shared  buff/cache  available
Mem:           3807  3178   121      39         833         628
Swap:             0     0     0
```

**~35 MB actual against ~628 MB available.** The 256M/64M figures are
compose limits — ceilings, not reservations — so they cost nothing up front.

Caveats worth stating plainly:

- The box is at ~83% used with **no swap**. 628 MB is the real headroom, and
  Authelia takes ~5% of it. Fine, but cloud is not roomy.
- The two large consumers are `hl-healthchecks` (361 MB, 70% of its 512M
  limit) and `hl-pangolin` (358 MB). If either needs to grow, revisit.

**Verdict: yes, cloud has enough RAM.**

## 4. Open question — the forwardAuth path from home

After the move, home's Traefik must reach Authelia on cloud for every request
to a protected route.

The appealing option is the existing Pangolin WireGuard tunnel
(K11 `100.89.128.4` ↔ cloudlab gerbil `100.89.128.1`), which would keep auth
traffic private and off the public internet. **This was not confirmed
workable.** `ping 100.89.128.4` from cloud's host namespace gets 100% packet
loss, because gerbil keeps the tunnel inside its own network namespace — the
Docker host cannot route into it without extra plumbing.

So the realistic starting point is forwardAuth over the public internet to
`https://auth.antonshubin.com`, which means one WAN round trip per request to
a protected route on home. Authelia's forward-auth check is cheap and the
session cookie means it is not a login each time, but it is a round trip.

**Resolve this before committing to the move.** Options, roughly in order of
preference:

1. Expose gerbil's tunnel to the cloud host namespace so `100.89.128.x` is
   routable, then point home's forwardAuth at the tunnel address.
2. Accept the public round trip and measure the added latency on a
   representative route.
3. Keep an Authelia on home purely for home-local routes and run cloud's own
   for cloud routes, accepting split sessions (the §1 downside).

## 5. Migration sketch

Not a runbook — the open question in §4 comes first.

1. Add `{ "name": "authelia" }` to `servers/cloud/config.json`.
2. Move `AUTHELIA_SESSION_SECRET` from `servers/home/.env` to
   `servers/cloud/.env`, re-encrypt, commit the `.env.age`. That is the
   only `AUTHELIA_*` variable in use.

   **Note:** `configuration.yml` uses that one value for *both*
   `session.secret` and `storage.encryption_key`. So it is not just a
   session secret — it is also the key the SQLite database is encrypted
   with, and moving it is what makes `db.sqlite` readable on the new host.
   Worth splitting into two variables while doing this move: as it stands,
   rotating the session secret would silently render the storage
   unreadable.
3. Copy `servers/home/configs/authelia/` to `servers/cloud/configs/authelia/`.
4. **Migrate `db.sqlite`** (`${VOLUMES_PATH}/authelia/data`). This holds TOTP
   enrolments and sessions. Copying it preserves existing 2FA devices; not
   copying it forces re-enrolment on every device. The encryption key from
   step 2 must move with it or the database is unreadable.
5. Repoint `auth.antonshubin.com` → `23.88.101.28` in Cloudflare.
6. Move `servers/home/configs/traefik/dynamic/01-home.yml`'s `authelia`
   forwardAuth middleware definition so both servers define one pointing at
   the cloud instance. Note the current definition targets
   `http://hl-authelia:9091` over Docker DNS — that only works on the host
   where the container runs, so home's copy needs the external URL.
7. Deploy cloud, then home. Verify a protected route on each host prompts and
   completes login, then remove Authelia from `servers/home/config.json`.

## 6. Rollback

Keep home's Authelia container and its `db.sqlite` until cloud has been
serving logins for a week. Rolling back is a DNS repoint plus re-adding the
stack to `servers/home/config.json` — no data migration in reverse, provided
home's database was not deleted.

## 7. Related

- #138 — Authelia in front of home's Syncthing GUI, the change that
  prompted this.
- #111 — the syncthing IaC discussion, where the cloud/offsite auth gap was
  first flagged as needing a cross-server decision.
- `docs/migrate-sg-to-gmktec.md` — the home-server migration this interacts
  with; if the K11 plan changes which host is "stable", revisit §2.
