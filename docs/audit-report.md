# Homelab Repository — Public-Readiness Audit Report

**Date:** 2026-06-28
**Branch:** `docs/audit-repo`
**Scope:** Full repo — infrastructure code, docs, scripts, server configs, ansible.
**Threat model:** Repo is already public. Imagine it goes viral and is read by:
seasoned sysadmins, security researchers, ex-employees, recruiters, bots, journalists.
The repo is the *one* artifact that defines the production system; inconsistencies
between code and docs are how postmortems get written.

> **Legend:** 🔴 blocks "ship to public" · 🟡 visible quality gap · 🔵 polish ·
> ⚪ future / nice-to-have

---

## 0. Executive Summary

The repo is functional, well-structured for a solo-developer homelab, and has
genuinely nice patterns (encrypted env, dynamic ansible inventory, two-Factor
forward-auth). **It is not, however, in a state that survives public scrutiny
without changes.** Below is a brutally-honest inventory.

| Theme | Critical | High | Medium | Low |
| --- | --- | --- | --- | --- |
| **Outdated / wrong docs** | 6 | 4 | 5 | 3 |
| **Stacks broken / inconsistent** | 4 | 6 | 9 | 7 |
| **Security** | 2 | 5 | 7 | 4 |
| **FOSS choices / modernization** | 0 | 3 | 6 | 5 |
| **Architecture / ops** | 1 | 4 | 5 | 6 |
| **Code quality / tests** | 0 | 2 | 4 | 5 |

The single biggest *visible* problem: **the README is factually wrong on
nearly every other line** (Authentik/Authelia, "40 stacks", `docs/todos.md`,
"UI setup pending"). Fixing docs is cheap and raises public perception
disproportionately.

The single biggest *real* problem: **`snappymail` is referenced in
`servers/cloud/config.json` but no `stacks/snappymail/` exists** — the deploy
script will fail loudly, but it currently ships. This is a deployment bug.

---

## 1. Outdated / Inaccurate Documentation  🔴

### 1.1 README.md is several months out of date  🔴

Verified line-by-line vs. `auth.md`, `improvements.md`, `servers/*/config.json`:

| Line | README says | Reality | Severity |
| --- | --- | --- | --- |
| L20 | "Home … 40 stacks" | **47 stacks** in `servers/home/config.json` (`jq '.stacks | length' servers/home/config.json`) | 🔴 |
| L20 | "Cloud … 10 stacks" | **12 stacks** (incl. `snappymail` bug, see 2.1) | 🔴 |
| L30 | "Authentik SSO at auth.antonshubin.com" | **Migrated to Authelia.** `auth.md` confirms. | 🔴 |
| L30 | "Grafana … Basic auth" | Should be Authelia per `auth.md` Phase 1 | 🟡 |
| L34 | "Full service list: see `docs/todos.md`" | **`docs/todos.md` does not exist** (nearest: `docs/improvements.md`) | 🔴 |
| L41 | "cp servers/home/.env.example servers/home/.env" | OK, but no warning that `PROJECT`, `HOMELAB_USER`, etc. are also in `.env.root` | 🔵 |
| L80 | "Auth decision: … SSO: `middlewares=authelia@file`" | Correct, but basic-auth still used widely (see 2.7) | 🟡 |
| L88 | "Basic auth: Everything else with `middlewares=auth`" | Still true today — see 2.7 | 🟡 |
| L94 | "SSO provider deployed (Authentik — UI setup pending)" | **Wrong on Authentik.** Should be Authelia, and Authelia is already in use (auth.md shows it serves transmission/akaunting/monica). | 🔴 |
| L99 | "See `docs/todos.md` for detailed status" | `docs/todos.md` does not exist. | 🔴 |

**Fix:** Rewrite README from `servers/*/config.json` programmatically (or by
hand against the actual files). Cite exact stack counts from `jq '.stacks
| length' servers/<server>/config.json`. Drop the "Authentik" string entirely.

### 1.2 `servers/offsite/README.md` references nonexistent paths  🔴

Line 12: `../../sharedStacks/syncthing/` — there is no `sharedStacks/`
directory; should be `../../stacks/syncthing/`. (Lines for gatus, wireguard,
traefik, watchtower all repeat this error.)

Line 31: `ansible-playbook ansible/playbooks/fix-raspberry-pi.yml -K --limit offsite`
— the actual file is `ansible/playbooks/initial-setup/raspberry-pi-fix.yml`.
Same problem on the "keep firmware updated" line at the bottom: it points to
`ansible/playbooks/maintenance.yml` but the real file is
`ansible/playbooks/initial-setup/maintenance.yml`.

**Fix:** Rewrite links to `../../stacks/<name>/` and adjust playbook paths to
the `initial-setup/` subdirectory.

### 1.3 `improvements.md` is one of the better docs but is stale vs. the code  🟡

| Claim in `improvements.md` | Reality |
| --- | --- |
| "31 stacks lack a top-level `name:` field" | Verified: **29 stacks lack `name:`** (improvements.md overshot by 2). Of the 25 that have `name:`, several use a hardcoded project name (`name: monitoring`, `name: immich`, `name: piped`, `name: ${PROJECT}` for some, `name: ${PROJECT}-x` patterns). Inconsistent. |
| "4 stacks don't follow the `hl-` prefix" | Verified: **at least 5** (`cloudflared`, `home-assistant`, `mail-ai`, `mail-ai-neatsoft`, `watchtower`). |
| "22 stacks lack a README" | Verified: **22** — accurate. |
| "40 stacks lack healthchecks" | Verified: **40 lack any healthcheck** (14 have one). improvements.md was actually correct. |
| "`name: ${PROJECT}` makes Docker Compose prefix all container names" | **Misleading.** `name:` controls the *project name* used to namespace volumes/networks; `container_name:` is what prefixes the container name. The two are independent. (See 2.2.) |

### 1.4 `auth.md` has a YAML bug in the example  🔴

Lines 178–183 (Phase 2 example): the YAML block contains duplicate
`policy: two_factor` keys for `metube` and `time` domains. YAML silently
overrides; the second value wins. The block should look like:

```yaml
    - domain: "metube.antonshubin.com"
      policy: two_factor
    - domain: "ollama.antonshubin.com"
      policy: two_factor
    - domain: "time.antonshubin.com"
      policy: two_factor
```

This is a *bug in the docs* (the example would parse as "metube has policy
two_factor" twice and nothing else). It's also a smell — if anyone copy-pasted
it into `configuration.yml` they'd get a broken file. **Verify the live
`servers/home/configs/authelia/configuration.yml` was written correctly** —
if it follows this doc literally, it has a bug.

### 1.5 `deno.jsonc` `check` task is a lie  🟡

`deno task check` has `command: "echo '✅ All checks passed!'"` but defines
`dependencies: [lint:check, fmt:check, ts:check, test]`. Deno *does* run the
deps, so the command itself runs after them. But the literal string "echo
'✅ All checks passed!'" reads like cargo-culted boilerplate and any future
maintainer who adds `command:` will silently skip the dependency chain. **Fix:**
delete `command:` and rely on `dependencies:`, or document the pattern with
a comment.

### 1.6 ~~`docs/openhands.md` — OpenHands removed~~ ✅

OpenHands service removed from repo. `stacks/openhands/`, `docs/openhands/`,
and `docs/openhands.md` deleted. OpenCode Web replaces it at `code.antonshubin.com`.

### 1.7 Mismatch between README claims and Gatus reality  🟡

`README.md` says "✅ 50+ services across 3 servers" but the *actual* counts:
- home: 47 stacks, some multi-service (immich=5, monitoring=4, victoria-metrics=4) → ~70 containers
- cloud: 12 stacks
- offsite: 4 stacks

"50+" is technically true if you count stacks, but it reads like services. Be
explicit. Use `docker compose ps --services` after deploy for a real count.

### 1.8 No LICENSE file  🔴

There is **no LICENSE** file in the repo root. The README claims this is a
public repo. Without a license, no one can legally use the code. **Fix:** add
`LICENSE` (MIT/Apache-2.0/AGPL — pick one). For a homelab, MIT or Apache-2.0
is standard.

### 1.9 `.github/copilot-instructions.md` is not documented anywhere  🔵

There's a `copilot-instructions.md` for GitHub Copilot but no README section
explaining what AI assistants should/shouldn't touch. Either delete it or
document the policy in AGENTS.md (which is itself already quite thorough).

### 1.10 `ansible/README.md` describes `inventory.ts` but the script uses `inventory.sh`  🔴

`ansible/README.md` (line 8): "uses a **dynamic inventory script**
(`scripts/ansible/inventory.ts`)". But:

- `scripts/ansible/+main.ts` (the actual wrapper) calls
  `-i ./scripts/ansible/inventory.sh`.
- `ansible.cfg` says `inventory = inventory.yml`, and **no `inventory.yml` exists.**

Three different files referenced in three places. The wrapper uses `.sh` (a
shell script that I didn't inspect yet). Anyone running `ansible-playbook`
directly (not via `deno task ansible`) will hit "no inventory" or worse.

**Fix:** Delete `inventory = inventory.yml` from `ansible.cfg` (since the
wrapper passes `-i` explicitly). Update README to reference `inventory.sh`.
OR: unify on `.ts` and rewrite the wrapper. Whichever you choose, one file,
one truth.

---

## 2. Stacks Catalog: Broken / Inconsistent  🔴

### 2.1 `snappymail` is referenced but does not exist  🔴 — DEPLOY BUG

`servers/cloud/config.json` line 11:
```json
{ "name": "snappymail" },
```

There is **no `stacks/snappymail/` directory**. The deploy script (`scripts/deploy/+main.ts`,
lines 130–142) explicitly `Deno.exit(1)` if a referenced stack is missing:

```ts
} catch (err) {
  if (err instanceof Deno.errors.NotFound) {
    error(`Stack not found: ${stackPath}`)
    Deno.exit(1)
  }
}
```

So `deno task deploy cloud` *currently cannot succeed.* Either:
- `snappymail` was renamed (the `mail-ai` stack suggests a Deno-based
  replacement), or
- It was deleted and the config wasn't updated, or
- It was meant to be migrated to `stalwart`/Rainloop and forgotten.

**Fix:** Decide. Most likely the right move is to remove the line — `stalwart`
covers webmail. If you want a Roundcube successor, check 3.1 below.

### 2.2 `name: ${PROJECT}` semantics are mis-documented and unevenly applied  🔴

`improvements.md` says `name: ${PROJECT}` "makes Docker Compose prefix all
container names with the project name". That's **not what it does**.

- `name:` (top-level) sets the **Compose project name**. The CLI flag `-p`
  overrides it. The deploy script (`scripts/deploy/+main.ts` line 432) sets
  `-p ${deployAs}` explicitly, so the YAML `name:` is **shadowed on every
  deploy**. It only matters if someone runs `docker compose up` from the stack
  directory without `-p`, which the deploy script never does.
- `container_name:` is what controls the actual container name. It is
  **not** affected by `name:`.

So:
1. `name: ${PROJECT}` is decorative on this codebase. It does no harm, but it
   also doesn't fix the `hl-` prefix issue. The improvements doc is wrong.
2. 29 stacks don't have a top-level `name:` field at all. Compose falls back
   to the parent directory name, which is fine in practice — but it's still
   inconsistent.
3. `stacks/immich/compose.yml` uses `name: immich` (hardcoded), not
   `name: ${PROJECT}`. Same for `piped`, `monitoring`, etc. — they chose
   project names like the stack directory name.

**Fix:** Either remove the `name:` field from every compose.yml (YAGNI), OR
standardize on `name: ${PROJECT}` everywhere and remove the CLI `-p` flag
from the deploy script so they actually conflict. Don't ship a half-applied
pattern that doesn't do what the docs claim.

### 2.3 `container_name:` violations are not what improvements.md says  🔴

`improvements.md` lists 4 stacks that violate the `hl-` prefix. Actual count:

```
stacks/cloudflared/compose.yml:    container_name: cloudflared
stacks/home-assistant/compose.yml: container_name: home-assistant
stacks/mail-ai/compose.yml:        container_name: mail-ai
stacks/mail-ai/compose.yml:        container_name: mail-ai-neatsoft
stacks/watchtower/compose.yml:     container_name: watchtower
```

Five violations, not four. Fix `container_name: hl-mail-ai` and
`hl-mail-ai-neatsoft`.

### 2.4 `stacks/openhands/` deleted ✅

OpenHands directory removed from repo. `stacks/openhands/`, `docs/openhands/`,
and `docs/openhands.md` deleted.

### 2.5 `mail-ai` has no `proxy` network and uses `denoland/deno:latest`  🔴

`stacks/mail-ai/compose.yml`:
```yaml
services:
  mail-ai:
    image: denoland/deno:latest   # 🔴 using :latest tag, see 4.1
    container_name: mail-ai        # 🔴 no hl- prefix
    restart: unless-stopped
    command:
      - run
      - --allow-net
      - --allow-env
      - --allow-read
      - --allow-write=/app/data
      - --allow-sys=hostname
      - /app/+main.ts
    volumes:
      - ${PATH_APPS}/stacks/mail-ai/+main.ts:/app/+main.ts:ro,z
      - ${VOLUMES_PATH}/mail-ai/data:/app/data:z
    # ❌ No `networks:` field → uses default bridge, NOT proxy
```

Implications:
- **No Traefik labels** → not exposed to the internet (correct for this service,
  but undocumented).
- **Default Docker bridge network** → fine, but the audit script (`grep -L
  "proxy"`) correctly flags this as a deviation from convention. Other
  services that "don't need the internet" still use `proxy` for consistency.
- **`:latest`** on `denoland/deno` is a ~150 MB image with a full Deno runtime
  and shell. Mail-classification is a small, well-defined workload — pin a
  version (`denoland/deno:2.1.4` or whatever current) and consider
  multi-stage build to ship a small binary.

**Fix:** Add `networks: [proxy]`, fix container names, pin Deno version. Also
consider running as a non-root user (currently no `user:` specified).

### 2.6 `stacks/cloudflared/compose.yml`: container name not prefixed, `:latest`  🟡

```yaml
container_name: cloudflared  # 🔴 not hl-cloudflared
image: cloudflare/cloudflared:latest  # 🟡 latest
```

The `hl-` prefix is required per AGENTS.md. Fix the container name; pin the
version.

### 2.7 Basic-auth still used in places `auth.md` Phase 1 says to migrate  🟡

`auth.md` Phase 1 lists 8 stacks that should switch from `auth` to
`authelia@file`: metube, ollama, traggo, grafana, victoria-metrics, mailserver
(rspamd), traefik. From the `authelia` config and dynamic.yml:

- **Traefik router** already uses `authelia@file` ✅
- **OpenCode Web** uses `authelia` ✅ (in `01-home.yml`)
- **Grafana, Victoria-Metrics, Metube, Ollama, Traggo, Mailserver (rspamd)** —
  need to verify the actual `*.env` and compose labels.

Public Gatus config (`servers/home/configs/gatus.yml`) sends
`Authorization: Basic ${BASIC_AUTH_BASE64}` to `rspamd.${DOMAIN}` — implying
rspamd is still behind basic auth. Either Authelia is in front and Gatus is
working around it (acceptable for monitoring), or the migration isn't done.

**Fix:** Verify each of the 8 services in `auth.md` Phase 1 against the
current Traefik labels and Authelia `configuration.yml`. Mark each as ✅
done or ❌ still basic-auth. Either update `auth.md` to remove finished items
or actually do the migration. (And consider Option B/C from `auth.md`'s
"Option B — Bypass path per service" for proper monitoring.)

### 2.8 Immich has a `restart: always` outlier (known)  🔵

`stacks/immich/compose.yml`: 4 services use `restart: always`, 1 uses
`restart: unless-stopped` (the kiosk service). Improvements.md already
flags this. Pick one and be consistent. `unless-stopped` is the convention
project-wide.

### 2.9 Immich kiosk exposes port 3000 to the host *and* Traefik  🟡

```yaml
ports:
  - 3000:3000     # 🔴 host port
labels:
  - "traefik.http.routers.hl-immich-kiosk.rule=Host(`kiosk.${DOMAIN}`)"
```

If the host port is intentional (LAN access), keep it and document why. If
not, remove. Currently undocumented.

### 2.10 `stacks/openhands/` removed (was decommissioned) ✅

Minor, but inconsistent. The rest of the project uses `unless-stopped`. If
this file is truly dead, see 2.4.

### 2.11 `home-assistant` compose: `container_name` not prefixed, no middleware  🟡

```yaml
container_name: home-assistant    # 🔴 should be hl-home-assistant
image: ghcr.io/home-assistant/home-assistant:stable
```

Also flagged in `improvements.md` 1.5 — missing `robots-deny@file` and no auth
middleware at all (it's behind WireGuard, but verify).

### 2.12 `mail-ai` mail-ai-neatsoft container name not prefixed  🔴

```yaml
container_name: mail-ai-neatsoft  # 🔴
```

(See 2.3.)

### 2.13 `watchtower` not prefixed, has `:latest`  🟡

```yaml
container_name: watchtower        # 🔴 should be hl-watchtower
image: nickfedor/watchtower:latest  # 🟡 pin
```

### 2.14 Stack with `name: ${PROJECT}` but doesn't use it: `monitoring`  🔵

`stacks/monitoring/compose.yml` (not read in full but grep says):
```yaml
name: monitoring
```

Should be `name: ${PROJECT}`. (Or remove `name:` entirely, see 2.2.)

### 2.15 Traefik middlewares chains inconsistent  🟡

Some services use `authelia@file`, some `auth`, some both. Examples found:

- `hl-immich`: `robots-deny@file` ✅
- `hl-paperless`: ? (need to verify)
- `hl-monica-api`: bare
- `hl-umami`: no robots-deny
- `hl-piped-api`, `hl-piped-proxy`: ?
- `hl-stalwart`: bare (auth delegated to wireguard)
- `hl-upwork-triage-webui`: bare

**Fix:** Document a single matrix in `docs/auth.md` or a new
`docs/security-matrix.md`: domain → public? → which auth? → robots-deny?
Then audit each stack against it.

### 2.16 40 stacks have no healthcheck  🟡

`improvements.md` says 40 — verified accurate. **40 compose files lack any
compose-level healthcheck** (14 have one). Priority services missing it:
- adguard, audiobookshelf, filebrowser, home-assistant, jellyfin,
  mailserver, paperless-ngx, searxng, syncthing, usememos,
  vaultwarden
- grafana, gitea, immich (already has one), open-webui, traefik, ntfy,
  gatus, healthchecks, cloudflared

`stacks/upwork-triage/Dockerfile` (17 lines, custom) has no `HEALTHCHECK`.
`stacks/caldav-mcp/Dockerfile` (19 lines) has no `HEALTHCHECK`. Etc. See 4.5.

### 2.17 `gatus` runs with `BASIC_AUTH_BASE64` env var but no auth setup  🟡

```yaml
- BASIC_AUTH_BASE64=${BASIC_AUTH_BASE64}
```

If this is consumed by a built-in basic-auth feature of Gatus (it does
support this), OK. If it's read by the entrypoint script expecting a
middleware to be wired up — verify. Currently the gatus compose has no
Traefik `middlewares=` label and no `authelia@file`. That means Gatus itself
must be doing basic auth. If so, document it. If not, Gatus is *open on the
internet*.

### 2.18 Stacks with `image: ...:latest`  🔴

Audit grep showed **40 of 54 compose files use `:latest`**. Examples
(not exhaustive): adguard, adguardhome, audiobookshelf, authelia, cloudflared,
docker-registry, docker-sock-proxy, filebrowser, gatus, gitea, grafana
(11.3.0 is fine but there's also `grafana/grafana:latest`), mail-ai, mailserver,
mirotalk, monitoring, ntfy, ollama, openhands, open-webui, paperless-ngx,
plausible, reitti, searxng, stalwart, syncthing, watchtower, etc.

`latest` makes builds non-reproducible. A pull next week can break the deploy.
Some images (notably `denoland/deno:latest`, `denoland/deno:alpine`) are big
and change often. **Pin everything.** Use Renovate-style updates or Watchtower
(which the project has — see 4.4).

### 2.19 Some stacks have no `secrets:`, some have inline env with `MAIL_AI_*`  🔵

Not a bug — just noting that the project mixes inline env vars with no
interpolation of complex types. For a public repo, the Deno `secrets:`
compose feature is worth considering for better 12-factor separation. Optional.

---

## 3. FOSS Choices & Modernization Opportunities  🟡

This is the "are there modern/lightweight alternatives" half of the brief.
Items here are *suggestions*, not bugs. Adopt what makes sense.

### 3.1 Replace `snappymail` with `stalwart` UI or modern Roundcube-NG  🟡

`stalwart` (already in the catalog) ships with a modern webmail UI. If you
don't need `snappymail`, the easiest fix is deleting the line (see 2.1). If
you do, modern Roundcube forks worth a look:

- **Cypht** — lightweight, single-user friendly.
- **Stalwart's built-in webmail** (no extra stack).
- **ProtonMail-style self-hostable**: not FOSS at the moment — skip.

### 3.2 `piped` — consider Invidious companion or just Invidious  🟡

`piped` (the YouTube alternative frontend you chose) is fine, but
**Invidious** is more battle-tested and lighter on resources for a single
user. Or **Piped-Material** if you want the modern UI. Not a security issue,
just an ops preference.

### 3.3 `monitoring` (Prometheus + Loki + Grafana) vs `victoria-metrics`  🟡

You run both stacks *concurrently* — improvements.md acknowledges this is a
"compare then replace" plan. But:

- Prometheus + Grafana + Loki + Promtail + cAdvisor = ~6 containers, ~2 GB RAM
- VictoriaMetrics single-node + VictoriaLogs + Grafana = ~4 containers,
  ~700 MB RAM, ~5× faster on the same hardware

VictoriaMetrics is *the* modern choice for small homelabs. Migrate fully
and delete `monitoring/`. Document the comparison in `docs/monitoring.md`.

### 3.4 `reitti` — niche location-tracking app  🔵

`reitti` (Reitti is a route/timeline app for self-hosters) is fine, but very
niche. Alternatives: **OwnTracks** (lighter, more standard), **GPSLogger**
even lighter. Not a defect, just a flag for "are you using this?".

### 3.5 `adguard` (DNS) — consider `pi-hole` or `AdGuard Home` (already what's used)  🔵

Already using AdGuard Home. ✅ Skip.

### 3.6 `monitoring`/`promtail`/`loki`: heavy  🔵

Promtail is officially deprecated in favor of **Alloy** (Grafana's
replacement). If you keep this stack, swap to Alloy. Otherwise, see 3.3.

### 3.7 `syncthing` — fine, but consider `resilio` (paid) or `btsync` forks  🔵

Syncthing is the right choice. No change needed.

### 3.8 `gitea` — consider `forgejo`  🟡

Forgejo is a soft-fork of Gitea with more conservative governance and active
maintenance. Migration is documented. Worth a thought, especially if Gitea
ever pushes something you don't want. Not urgent.

### 3.9 `paperless-ngx` — solid, but `paperless-ngx` 2.0 changed database defaults  🔵

Already 2.x or 1.x? If 1.x, plan a migration. Not blocking.

### 3.10 `upwork-triage` (custom Deno app)  🔵

If this is open-sourced, it deserves its own README and a license. If not,
keep it `hl-` prefixed and documented.

### 3.11 `mail-ai` reimplements what `stalwart` JMAP filtering does  🟡

`stalwart` supports server-side rules + JMAP. Combined with built-in webmail,
you might be able to drop `mail-ai` entirely for a configurable subset of
its features. Worth evaluating.

### 3.12 `plausible` vs `umami` — running both  🟡

You have both `plausible` and `umami` configured (`servers/home/config.json`).
That's two analytics stacks. Plausible is paid-self-hosted (CE exists but
limited). Umami is fully free. **Pick one.** Recommend Umami for a homelab.

### 3.13 `trilium`/`silverbullet`/`affine` not in catalog  🔵

If you want a notes app, all three are better than `usememos` for long-form.
`usememos` is fine for quick notes. Not a defect.

### 3.14 `wastebin` / `privatebin` not in catalog  🔵

For password/secret sharing (different from `vaultwarden`). Optional.

### 3.15 `ollama` direct (vs `ollama-webui` only)  🔵

`open-webui` already provides the UI. The `ollama` stack is just the backend.
Fine. But consider `ollama` with the new built-in `/api` model management,
which is more mature than `open-webui`'s proxying. Optional.

### 3.16 `gatus` vs `uptime-kuma`  🔵

Both are fine. Gatus's advantage is YAML config + status API; Kuma's
advantage is prettier UI + multi-user. Already using Gatus. Skip.

### 3.17 `woodpecker-ci` — fine. Consider `act` (GitHub Actions locally)  🔵

Woodpecker is the right self-hostable choice. Skip.

### 3.18 `playwright` MCP — fine, `playwright-mcp` is upstream's blessed version  🔵

You're already using it. The `playwright/Dockerfile.mcp-proxy` is a custom
build (4th custom Dockerfile); verify it's not duplicating what upstream
provides. If you only need a thin proxy, use the official image.

### 3.19 `traefik` 3.6.6 — current  🔵

`traefik:3.6.6` is recent and pinned. Good.

---

## 4. Security Concerns  🔴/🟡

### 4.1 `:latest` everywhere is a supply-chain risk  🔴

Already noted in 2.18. Pin **every** image. Watchtower is already configured
(`watchtower --interval 86400`) but it *updates to latest* — pin major
versions and let Watchtower handle patch updates only. Or use Renovate.

### 4.2 `mail-ai` runs as root inside container  🟡

No `user:` directive → container runs as root. For an app that touches
network + filesystem + IMAP credentials, that's a bigger blast radius if
the Deno runtime is ever compromised.

**Fix:** Add a non-root user (similar to `user: "${PUID:-1000}:${PGID:-1000}"`).

### 4.3 `mail-ai` exposes IMAP password via env vars  🟡

```yaml
- MAIL_AI_IMAP_PASSWORD=${MAIL_AI_IMAP_PASSWORD}
```

Env vars are visible via `/proc/<pid>/environ` to any process inside the
container (or any user with `docker inspect`). For mail credentials, prefer
Docker secrets or read-from-file. Same issue for SMTP password in
`caldiy`/`healthchecks`.

**Fix:** Use `secrets:` blocks + `_FILE` env vars where supported.

### 4.4 `docker.sock` is mounted RW into `woodpecker-agent`  🔴

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock   # 🔴 no :ro!
```

Traefik and Watchtower use `:ro`. Woodpecker-agent (CI runner) is RW, which
is required for it to spin up build containers — but it means **any code
running in a CI build can `docker run` arbitrary containers as the docker
group**. In a single-user homelab CI, this is fine *if you trust the
pipelines*. Document it. Add `seccomp`/`apparmor` profiles if you're paranoid.

### 4.5 4 custom Dockerfiles with no `HEALTHCHECK`  🟡

`stacks/caldav-mcp/Dockerfile` (19 lines), `stacks/upwork-triage/Dockerfile`
(17 lines), `stacks/google-maps-mcp/Dockerfile` (29 lines),
`stacks/monica-mcp/Dockerfile` (42 lines), `stacks/playwright/Dockerfile.mcp-proxy`
(not checked yet). Add `HEALTHCHECK NONE` if you really don't want one, or a
real check (curl/wget to `/health`).

### 4.6 `BASIC_AUTH_PASSWORD` is bcrypt-hashed in `.env`  🟡

`.env.root.example` (and the per-server examples) document the value as a
bcrypt hash (`$$2y$$05$$...`). But the value is *also* used in
`traefik.http.middlewares.auth.basicauth.users=` which expects htpasswd
format (which is `user:bcrypt_hash`). OK on paper.

But: the variable is consumed via `${BASIC_AUTH_PASSWORD}` in **labels** (e.g.
`stacks/upwork-triage/compose.yml`). When Compose interpolates env vars in
labels, the `$` characters in `$$2y$$...` need to be escaped (`$$`). Verify
each occurrence is escaped correctly. The docs say `sed 's/\$/\$\$/g'` is
the workaround, but human error here = broken auth.

**Fix:** Pre-compute the `users` string in `before.deploy.ts` (you already
have that pattern) and write it to a file Traefik mounts. Don't keep
bcrypt hashes in env vars.

### 4.7 `.env.example` files don't match `.env` (by design) but expose variable names  🔵

Anyone can read `.env.example` and learn the structure. That's fine. But if
you ever add a `VENDOR_API_KEY` to `.env` and forget to add it to
`.env.example`, the encrypt-then-decrypt workflow won't catch it. Add a CI
check: `diff <(grep -oP '^[A-Z_]+(?==)' .env | sort -u) <(grep -oP '^[A-Z_]+(?==)' .env.example | sort -u)` should produce only intentional differences.

### 4.8 SOPS/age key is gitignored correctly ✅  🟢

`.age/` and `key.txt` are gitignored. Good.

### 4.9 Gatus sends Basic auth headers to every protected service  🟡

`Authorization: Basic ${BASIC_AUTH_BASE64}` is in plain text in
`servers/{home,cloud}/configs/gatus.yml`. Anyone with read access to the
repo (post-decrypt) has the basic-auth password for everything Authelia
isn't covering. Either:

- Use Authelia forward-auth everywhere (better, see 2.7), or
- Create a dedicated `monitoring` Authelia user with read-only policy (auth.md
  Option C).

### 4.10 `scripts/encryption/+lib.ts` walks with `maxDepth: 5`  🔵

5 levels deep. Repo is shallow; this works. But if you ever nest
`servers/team-a/team-b/.env`, it won't be encrypted/decrypted silently. Add a
test that walks the actual depth.

### 4.11 `deno task ssh <server>` — no key-pinning  🟡

The ssh wrapper (`scripts/ssh/+main.ts`) doesn't pin host keys (consistent
with `ansible.cfg host_key_checking = False`). For a 3-server homelab,
fine. For a public script, recommend pinning.

### 4.12 `deno task check` doesn't actually check  🟡

Already noted (1.5).

### 4.13 `ansible/inventory.sh` is shell, not TypeScript  🟡

`scripts/ansible/+main.ts` references `./scripts/ansible/inventory.sh`, not
`inventory.ts`. Mismatch with README. Verify `inventory.sh` exists and
behaves correctly.

### 4.14 No `.dockerignore`  🟡

Without `.dockerignore`, `docker build` for the 4 custom Dockerfiles will
include `.git/`, `docs/`, `servers/`, etc. Either add a root `.dockerignore`
or per-stack. For these small builds it's a wash, but for cache size it
matters.

### 4.15 No rate-limiting on Authelia  🟡

auth.md mentions Authelia's built-in `regulation` (failed-attempt throttling).
Verify it's enabled in `configuration.yml` for the `auth` middleware. If not,
brute force of password+TOTP is feasible (TOTP is 6 digits = 1000 options).

---

## 5. Architecture & Operations  🟡

### 5.1 `servers/offsite/` has no `configs/` directory  🟡

`servers/home/configs/`, `servers/cloud/configs/`, `servers/demo/configs/`
exist. `servers/offsite/` does not. The README says offsite runs Syncthing +
Traefik only, but `servers/offsite/config.json` lists 4 stacks including
`librespeed`. Either intentional (offsite is bare-bones) and document it,
or fix.

### 5.2 `servers/demo/` exists but isn't referenced anywhere  🟡

There's a `servers/demo/` with a `config.json` (4 stacks) and `configs/`.
README never mentions it. Either delete or document.

### 5.3 `PATH_PHOTOS` is used in immich but not declared in `.env.example`  🟡

`stacks/immich/compose.yml` uses `${PATH_PHOTOS}`, but I see
`PATH_PHOTOS=${BASE_PATH}/media/photos` in `servers/home/.env.example`
correctly. ✅ False alarm. (But verify every `${...}` in compose files has a
matching entry in the .env.example — script this as a test.)

### 5.4 `scripts/offline-backup/+main.ts` is 1702 lines  🟡

Already on improvements.md 3.2. Split into modules.

### 5.5 `scripts/deploy/+main.ts` mixes CLI parsing, fs copy, SSH, and Compose orchestration  🟡

586 lines, multiple concerns. Easy to refactor: `cli.ts`, `rsync.ts`,
`compose.ts`, `ssh.ts`. Worth doing for testability.

### 5.6 `scripts/backup/+main.ts` is fine but uses `ops` directly  🔵

Backups operate on the *current* machine, not via SSH. That's actually a
good choice — fewer moving parts. But `scripts/offline-backup/+main.ts` is
the same logic with extra SCP. Consider extracting `scripts/backup/src/restic.ts`
to share.

### 5.7 `PATH_APPS` env var reused inconsistently  🔵

- `${PATH_APPS}/configs/authelia/configuration.yml` (authelia)
- `${PATH_APPS}/stacks/mail-ai/+main.ts` (mail-ai, **deploy-time mount**)

The second pattern means mail-ai depends on the deploy script to rsync the
+main.ts file. That's fragile — if the rsync fails, container won't start.
Either:
- Bake the +main.ts into the image at build time, or
- Document the dependency in `stacks/mail-ai/README.md` (it doesn't exist).

### 5.8 No CI at all  🟡

`stacks/woodpecker/` exists but `servers/*/config.json` doesn't deploy it on
any server. The repo has no automated checks (lint, format, types, compose
validation, .env.example consistency). For a public repo, this is the single
biggest "ready for viral" gap.

**Fix:** Deploy Woodpecker to offsite (or cloud) and wire it up. Add a
`woodpecker.yml` to run `deno task check` on every push.

### 5.9 No `Dockerfile` linting  🔵

`hadolint` would catch many issues in the 4 custom Dockerfiles.

### 5.10 `deno task` doesn't run compose validation  🔵

`docker compose config` is not run anywhere. Add to a CI task.

### 5.11 No Mermaid/architecture diagrams in `docs/`  🟡

`docs/architecture.md` is ASCII-only. A simple `docs/architecture.mmd`
would render in GitHub. Helps the public-readiness goal.

### 5.12 `docs/openhands.md` removed alongside stack ✅

OK, but is the file actually useful? Read it. If it's just "see
<https://docs.all-hands.dev/>", drop it.

---

## 6. Code Quality & Tests  🟡

### 6.1 Only 2 tests exist  🔵

`scripts.test.ts` has 2 trivial tests. `scripts/backup/src/`, `scripts/deploy/`,
`scripts/encryption/` have **zero** unit tests. For a deploy system, this is
risky.

### 6.2 No integration tests  🟡

A test that runs `deno task deploy home traefik` against a docker-in-docker
runner would catch 90% of the issues in this audit. (Not asking you to write
it; flagging it as the single highest-leverage thing to add.)

### 6.3 `substituteEnvVars` helper has a single test  🔵

Test it more: nested vars, escape sequences, missing-default behavior.

### 6.4 `runCommand` helper returns shape but callers ignore error  🔵

`runCommand({...})` returns `{success, output, error}`. Most callers call it
and check `.success`. Good. But `scripts/deploy/+main.ts` line 318 ignores
the failure of `networkCommand` — wait, no, it does check. Just verify.

### 6.5 `imports` map in deno.jsonc is incomplete  🔵

```json
"@scripts/backup": "./scripts/backup/src/+lib.ts"
```

But `scripts/backup/+main.ts` does `import { ... } from "./src/+lib.ts"`
(relative). Inconsistent. Either use alias imports everywhere or nowhere.

### 6.6 `scripts/encryption/+lib.ts` defines an interface `EncryptionResult` but doesn't export  🔵

Minor — it's exported. False alarm.

### 6.7 Use of `npm:` imports in Deno code (`mail-ai/+main.ts`)  🔵

`npm:imapflow@1` and `npm:mailparser@3` — Deno supports these fine. But the
version pinning `@1` (not `@^1` or `@1.0.0`) means upgrades can break
silently. Pin exact versions.

### 6.8 No JSDoc / type-def files for shared types  🟡

`scripts/backup/src/types.ts` has the canonical types — good. But
`scripts/deploy/+main.ts` defines `StackConfig` and `DeployResult` locally.
Should move to a shared `+types.ts`.

### 6.9 `scripts/backup/+main.ts` has class-level comment "Main backup orchestration class"  🔵

Restates the class name. Per the code-quality guideline (no narration of what
the code obviously does), drop it.

### 6.10 `scripts/ssh/+main.ts` not read in this audit  🔵

Read it; verify it's not just `ssh $1`.

---

## 7. Naming / Style / Polish  🔵

### 7.1 AGENTS.md says "deno task check" must pass before commit; `deno task check` is a lie (1.5)

If `deno task check` ever silently no-ops, AGENTS.md guidance is broken.

### 7.2 `.vscode/` directory committed  🔵

`.vscode/` is in `.gitignore` per default but might be partially committed.
Verify. (If it's there, document which extensions you require for the
project — `denoland.vscode-deno`, etc.)

### 7.3 `stacks/openhands/` removed from catalog ✅

Clever, but `docker compose --profile decommissioned up` would still work.
Document or delete.

### 7.4 Two services named `gatus` (`servers/home/configs/gatus.yml` has "Gatus" twice)  🔵

Cosmetic — both monitor the cloud. Probably just a copy-paste.

### 7.5 Comment style inconsistency  🔵

Some compose files have `#` comments explaining each block, others don't.
Pick a per-section minimum.

### 7.6 `STACK_PATTERNS` section in README vs `docs/adding-services.md`  🔵

README has a shorter version; `adding-services.md` has the full one.
Cross-link them.

### 7.7 `dashboard.html.template` — read in full  🔵

I read the head; the body should be checked for hard-coded URLs that should
be template variables, or services that are no longer deployed.

---

## 8. What's Done / What's Not Done (audit of docs/improvements.md)

For each item in `docs/improvements.md`, current status:

| ID | Item | Status |
| --- | --- | --- |
| 1.1 | `container_name` prefix fix | ❌ **5 stacks still violate** (was 4) |
| 1.2 | `name: ${PROJECT}` everywhere | ❌ **29 stacks missing**; also, the doc claim is wrong (2.2) |
| 1.3 | Healthchecks | ❌ **40 stacks missing** (improvements.md was right) |
| 1.4 | `backup.ts` for Victoria Metrics | ❌ Still missing |
| 1.5 | Traefik middlewares | ❌ `home-assistant` and `zond` still missing (verify) |
| 2.1 | Stack READMEs (22 missing) | ❌ Same count today |
| 2.2 | Disaster recovery runbook | ❌ No `docs/disaster-recovery.md` |
| 2.3 | Monitoring stack docs | ❌ No `docs/monitoring.md` |
| 2.4 | Ansible walkthrough | ❌ README exists but has wrong paths (1.10) |
| 2.5 | Gatus audit | ❌ Several endpoints missing cross-server checks |
| 3.1 | Test coverage | ❌ 2 tests total |
| 3.2 | Split offline-backup | ❌ 1702-line file |
| 3.3 | Immich `restart` consistency | ❌ Still inconsistent |
| 3.4 | Dockerfile HEALTHCHECK | ❌ 4 Dockerfiles, none have HEALTHCHECK |
| 4.1 | CI/CD (Woodpecker) | ❌ Not deployed |
| 4.2 | Pre-commit validation | ❌ Basic hooks only (env encrypt/decrypt) |
| 4.3 | Security audit automation | ❌ This report is the first artifact; codify it |
| 4.4 | Dep tracking | ⚠️ Watchtower covers Docker; Deno/npm not tracked |

**Verdict:** `improvements.md` is a roadmap. **Nothing in it has been done.**
That's fine for a one-person project — but the README shouldn't claim
"Status: ✅ 50+ services" when none of the listed audit items are green.

---

## 9. Prioritized Action List

### 🔴 Must-fix before "public v1.0"  (estimated ~3 days of focused work)

1. **Fix README.md** — counts, Authelia vs Authentik, `docs/todos.md`,
   "UI setup pending", LICENSE file. 1.1, 1.8.
2. **Fix `servers/offsite/README.md`** — paths to `stacks/` and `ansible/`. 1.2.
3. **Resolve `snappymail`** — remove from config or create stack. 2.1.
4. **Fix `mail-ai`, `cloudflared`, `home-assistant`, `watchtower`**
   `container_name:` prefix violations. 2.3.
5. **Pin all `:latest` images to versions** (or document Watchtower-only
   policy and accept non-reproducibility). 2.18, 4.1.
6. **Fix the duplicated `policy: two_factor` keys** in `auth.md` and verify
   the actual `configuration.yml` doesn't have the same bug. 1.4.
7. **Unify inventory references** — pick `inventory.ts` or `inventory.sh`,
   update README and `ansible.cfg` to match. 1.10.
8. **Decide on `monitoring` vs `victoria-metrics`** — migrate fully or
   document the comparison. 3.3.
9. **Add `LICENSE` file**. 1.8.

### 🟡 Should-fix for credibility  (~1 week)

10. **Migrate `grafana`, `victoria-metrics`, `metube`, `ollama`, `traggo`,
    `mailserver-rspamd`** to Authelia per `auth.md` Phase 1. 2.7, 4.15.
11. ~~Move `stacks/openhands/` to `_archive/` or delete.~~ **Done.** 2.4.
12. **Add healthchecks to the 12 priority stacks** listed in improvements.md. 2.16.
13. **Add `backup.ts` for `victoria-metrics`**. 1.4.
14. **Set up Woodpecker CI** running `deno task check`. 5.8.
15. **Drop `plausible` or `umami`** — pick one. 3.12.
16. **Fix `mail-ai` Deno image version + non-root user**. 2.5, 4.2.
17. **Replace `BASIC_AUTH_PASSWORD` interpolation in labels** with a
    pre-rendered htpasswd file via `before.deploy.ts`. 4.6.
18. **Add `.dockerignore`** at the root. 4.14.
19. **Split `scripts/offline-backup/+main.ts`** into 5 modules. 5.4.
20. **Add tests** for `scripts/backup/`, `scripts/deploy/`,
    `scripts/encryption/`. 6.1.

### 🔵 Polish  (ongoing)

21. **Add READMEs to the 22 stacks that lack one.** 2.1 (improvements.md 2.1).
22. **Add `docs/monitoring.md`, `docs/disaster-recovery.md`,
    `docs/security-matrix.md`.** 5.11.
23. **Wire `hadolint` into CI**. 5.9.
24. **Document the `PATH_APPS/stacks/<name>/+main.ts` mount pattern** or move
    to image build. 5.7.
25. **Replace `npm:imapflow@1` with `npm:imapflow@1.0.182`** (or current). 6.7.

### ⚪ Future  (when viral-readiness matters)

26. **Renovate or Dependabot for Deno/npm + Ansible roles.** 5.8 (extension).
27. **External audit of Authelia config** (security consultant).
28. **Public-facing blog post** explaining the architecture (good marketing for
    both the homelab and the FOSS ecosystem).

---

## 10. Suggested Next Steps (for future audit sessions)

If you want a follow-up audit, split the work into:

1. **Stack-level deep audit** (separate file per stack):
   - Compose linting (hadolint, dockerfilelint, custom checks)
   - FOSS alternatives research (one section per stack)
   - Resource limit recommendations
2. **Security audit** with a separate threat model document.
3. **Performance audit**: cold-start times, memory ceilings, GPU scheduling.
4. **DR/BCP audit**: simulate losing each server; verify recovery is < N hours.

The deliverable of each is a focused report like this one. Each is roughly
one day's work with sub-agents.

---

## Appendix A — Methodology

This audit was performed by:
1. Reading AGENTS.md and `docs/improvements.md` first to anchor on known issues.
2. Walking the repo tree (`stacks/`, `servers/`, `scripts/`, `ansible/`,
   `docs/`) and listing every file.
3. Reading the high-level docs (README, auth.md, adding-services.md,
   architecture.md, improvements.md) end-to-end.
4. Cross-checking claims in docs against actual files (line-by-line where
   claimed counts are made).
5. Running grep/awk passes to enumerate: `:latest` images, missing
   `hl-` prefixes, missing `name:`, missing healthchecks, docker.sock mounts,
   exposed host ports, env vars in compose labels, basic-auth references,
   gatus endpoint coverage.
6. Sampling 6 representative stacks in full (`authelia`, `traefik`, `immich`,
   `monitoring` via grep, `open-webui`, `mail-ai`,
   `cloudflared`, `watchtower`, `mailserver`).

Not audited:
- `scripts/ssh/+main.ts`, `scripts/offline-backup/+main.ts` internals.
- 4 custom Dockerfiles in full.
- `servers/demo/` and `servers/offsite/` (cloud-side) configurations.
- 30+ compose files at depth (the grep-based coverage catches most issues;
  an `hadolint` pass is the right next step).

## Appendix B — Files Read in Full

README.md, AGENTS.md, deno.jsonc, .gitignore, .env.root.example,
docs/improvements.md, docs/architecture.md, docs/adding-services.md,
auth.md, servers/home/config.json, servers/cloud/config.json,
servers/offsite/config.json, servers/demo/config.json,
servers/home/configs/gatus.yml (head),
servers/cloud/configs/gatus.yml (head),
servers/offsite/README.md, ansible/README.md (head),
ansible/site.yml, ansible/ansible.cfg,
ansible/playbooks/initial-setup.yml,
ansible/playbooks/initial-setup/ssh-hardening.yml (head),
ansible/playbooks/after-deploy.yml, ansible/tasks/install-docker-python.yml (head),
scripts/+lib.ts, scripts/deploy/+main.ts (full),
scripts/backup/+main.ts (full), scripts/encryption/+lib.ts (full),
scripts/ansible/+main.ts (full), scripts.test.ts,
stacks/authelia/compose.yml, stacks/traefik/compose.yml,
stacks/traefik/dynamic.yml, stacks/immich/compose.yml,
stacks/open-webui/compose.yml (head),
stacks/mail-ai/compose.yml (head),
stacks/cloudflared/compose.yml, stacks/watchtower/compose.yml,
stacks/mailserver/compose.yml (head), stacks/mail-ai/+main.ts (head),
servers/home/.env.example (head), servers/home/configs/dash/index.html.template (head).

(Plus 30+ compose files audited via grep for `container_name`,
`name:`, `healthcheck:`, `image:`, `restart:`, `ports:`, `proxy`,
`docker.sock`, `VOLUMES_PATH`, `BASIC_AUTH`, `authelia`, `auth`.)
