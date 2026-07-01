# Improvement Roadmap

Audit of the homelab infrastructure repository conducted 2026-06-26. All findings
are categorized by priority and estimated effort.

> **Legend:** 🔴 must-have · 🟡 nice-to-have · 🔵 polish · ⚪ future

---

## 🔴 Phase 1 — Infrastructure Hygiene

### 1.1 Fix `container_name` prefix consistency

4 stacks don't follow the `hl-` prefix convention (conflicts with other projects):

| Stack | Current | Should be |
|---|---|---|
| `cloudflared` | `cloudflared` | `hl-cloudflared` |
| `home-assistant` | `home-assistant` | `hl-home-assistant` |
| `mail-ai` | `mail-ai`, `mail-ai-neatsoft` | `hl-mail-ai`, `hl-mail-ai-neatsoft` |
| `watchtower` | `watchtower` | `hl-watchtower` |

> **Note:** Adding `name: ${PROJECT}` (1.2) makes Docker Compose prefix all
> container names with the project name, which effectively solves 1.1. If both
> are done, the `container_name` fields can remain as-is since the `name:` field
> provides the prefix.

### 1.2 Add `name: ${PROJECT}` to compose files

31 stacks lack a top-level `name:` field. Docker Compose uses the parent
directory name by default, which can cause conflicts when deploying with custom
project names. Add to every `compose.yml`:

```yaml
name: ${PROJECT}
```

However, some stacks are multi-service and need a **unique** project name to
avoid container name collisions. For these, use a scoped name:

```yaml
name: ${PROJECT}-immich
name: ${PROJECT}-piped
```

Affected stacks: `adguard`, `audiobookshelf`, `caldav-mcp`, `caldiy`,
`docker-registry`, `docker-sock-proxy`, `email-mcp`, `filebrowser`, `gitea`,
`google-maps-mcp`, `grafana`, `healthchecks`, `home-assistant`, `immich`\*,
`jellyfin`, `mail-ai`, `mailserver`, `metube`, `monica-mcp`, `nginx`,
`openhands`, `open-webui`, `paperless-ngx`, `piped`\*, `playwright`,
`transmission`, `vaultwarden`, `victoria-metrics`, `wireguard`, `woodpecker`.

> \*`immich` and `piped` should use `${PROJECT}-immich` / `${PROJECT}-piped`
> since they run multiple services that could conflict with other stacks.

### 1.3 Add compose-level healthchecks

40 stacks lack any healthcheck (either Dockerfile or compose-level). While not
all services need one, every stateful or user-facing service would benefit.
Priority targets (by impact):

1. **Stateful services**: `adguard`, `audiobookshelf`, `authelia`, `filebrowser`,
   `home-assistant`, `jellyfin`, `mailserver`, `paperless-ngx`,
   `searxng`, `syncthing`, `usememos`, `vaultwarden`
2. **User-facing**: `grafana`, `gitea`, `immich`, `open-webui`
3. **Infra**: `traefik`, `ntfy`, `gatus`, `healthchecks`, `cloudflared`

### 1.4 Add `backup.ts` for Victoria Metrics

Only `victoria-metrics` needs a backup config — it stores timeseries and log data
that would be costly to lose or regenerate:

| Stack | Volumes / Data |
|---|---|
| `victoria-metrics` | `${VOLUMES_PATH}/victoria-metrics/data`, `${VOLUMES_PATH}/victoria-logs/data` |

The other stateful candidates (`metube` media, `nginx` static content, `zond`
config) are either easily regenerated or low-value — skip them.

### 1.5 Add missing Traefik middlewares

2 stacks expose services without anti-crawler or auth protection:

| Stack | Issue | Fix |
|---|---|---|
| `home-assistant` | No `middlewares` label at all | Add `robots-deny@file`, consider `authelia@file` |
| `zond` | Missing `robots-deny@file` | Add middleware label |

Additionally, `caldiy` has its middleware line commented out — uncomment or
document why.

---

## 🟡 Phase 2 — Documentation & Observability

### 2.1 Create README.md for undocumented stacks

22 stacks lack a README.md:

`akaunting`, `authelia`, `caldav-mcp`, `docker-registry`, `gitea`, `grafana`,
`librespeed`, `mail-ai`, `mirotalk`, `monica`, `monica-mcp`, `monitoring`,
`ollama`, `paperless-ngx`, `plausible`, `reitti`, `stalwart`, `traggo`,
`umami`, `usememos`, `zond`

Each should follow the pattern in [adding-services.md](adding-services.md):
service description, setup, configuration notes, troubleshooting.

### 2.2 Write disaster recovery documentation

`docs/` lacks a dedicated disaster recovery runbook covering:
- Full restore from offsite backup (etcd backup, volume restore)
- Single-service data restore from backup tarball
- Server replacement procedure (new Hetzner node → fully operational)
- Database-specific restore commands (PostgreSQL, SQLite, etc.)

### 2.3 Document the monitoring stack

Two monitoring stacks exist:
- `stacks/monitoring/` — Loki, Promtail, Prometheus, cAdvisor, Grafana
- `stacks/victoria-metrics/` — VictoriaMetrics, VictoriaLogs, Grafana

**Purpose:** Both run concurrently for comparison. If VictoriaMetrics proves
superior in performance, resource usage, and query speed, it will replace the
Grafana stack entirely. Document this rationale and track the decision.

### 2.4 Ansible playbooks walkthrough

`ansible/` has playbooks and tasks but no guide explaining:
- Which playbooks exist and what they do
- How to run them (`deno task ansible <playbook>`)
- Inventory setup
- Idempotency guarantees

### 2.5 Gatus monitoring gaps

Cross-server monitoring is required per [adding-services.md](adding-services.md).
Audit each service to confirm it has a Gatus endpoint on the *opposite* server
and the health badge is present in `dash/index.html.template`.

---

## 🔵 Phase 3 — Code Quality & Tests

### 3.1 Test coverage

Currently only `scripts.test.ts` exists (2 utility functions). Priority targets:

| Module | Test focus |
|---|---|
| `scripts/backup/` | Config parsing, command execution, SSH/SCP workflows |
| `scripts/deploy/` | Stack selection, config generation, SSH deployment |
| `scripts/encryption/` | SOPS/age integration, env round-trip |
| `scripts/+lib.ts` | Utility functions (currently 2 tests exist) |
| `scripts/offline-backup/` | Complex multi-step backup logic |

### 3.2 Split `scripts/offline-backup/+main.ts`

At ~1700 lines, this is the largest file in the codebase. It should be split
into smaller modules following the pattern in `scripts/backup/`:
- `+main.ts` — entry point / CLI
- `src/backup.ts` — backup logic
- `src/transfer.ts` — SCP/transfer
- `src/notify.ts` — ntfy notifications
- `src/config.ts` — configuration

### 3.3 Immich `restart` inconsistency

Immix uses `restart: always` for 4 services but `restart: unless-stopped` for
1 service. Align to the project convention (`unless-stopped`).

### 3.4 Missing Dockerfile HEALTHCHECK

The 4 custom Dockerfiles (`caldav-mcp`, `google-maps-mcp`, `monica-mcp`,
`playwright` MCP proxy) should include Dockerfile-level
`HEALTHCHECK` instructions as a fallback even when compose-level healthchecks
exist.

---

## ⚪ Phase 4 — Future / Stretch

### 4.1 CI/CD pipeline (Woodpecker)

No CI pipeline exists yet. Use **Woodpecker** (already in `stacks/woodpecker/`)
instead of GitHub Actions — all infrastructure must be self-hosted.

A minimal pipeline would:
- Run `deno task check` on every push
- Validate compose files (`docker compose config`)
- Check for plaintext `.env` files
- Deploy on tag or manual trigger

### 4.2 Pre-commit hooks for compose validation

Extend the existing git hooks to validate:
- `container_name` starts with `hl-`
- `name: ${PROJECT}` is present
- `restart: unless-stopped` is consistent
- Resource limits are present

### 4.3 Security audit automation

Script to scan for common issues:
- Missing auth middlewares on exposed services
- Plaintext secrets in compose files
- Outdated Docker image tags
- Docker sockets exposed without proxy

### 4.4 Dependency update tracking

Already partially covered by **Watchtower** (in `stacks/watchtower/`) for Docker
image updates — confirm it's running and configured correctly.

For Deno/JS dependencies (JSR, npm) and Ansible roles, no automated tracking
exists yet. Consider periodic manual review or a Woodpecker cron job.

---

## Priority Matrix

| Task | Impact | Effort | Phase |
|---|---|---|---|
| `container_name` prefix fix | solved-by(1.2) | — | 🔴 1.1 |
| `name: ${PROJECT}` | medium | low (31 files, sed) | 🔴 1.2 |
| Healthchecks | high | medium (~40 files) | 🔴 1.3 |
| `backup.ts` for Victoria Metrics | high | low (1 file) | 🔴 1.4 |
| Traefik middlewares | high | low (2 files) | 🔴 1.5 |
| Stack READMEs | medium | high (22 files) | 🟡 2.1 |
| DR runbook | high | medium | 🟡 2.2 |
| Monitoring stack docs | medium | low | 🟡 2.3 |
| Ansible walkthrough | medium | low | 🟡 2.4 |
| Gatus audit | medium | medium | 🟡 2.5 |
| Test coverage | medium | high | 🔵 3.1 |
| Split offline-backup | low | medium | 🔵 3.2 |
| Immich restart fix | low | low (1 file) | 🔵 3.3 |
| Dockerfile HEALTHCHECK | medium | low (5 files) | 🔵 3.4 |
| CI/CD (Woodpecker) | medium | high | ⚪ 4.1 |
| Pre-commit validation | low | medium | ⚪ 4.2 |
| Security automation | low | medium | ⚪ 4.3 |
| Dep tracking (non-Docker) | low | low | ⚪ 4.4 |
