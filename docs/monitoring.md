# Monitoring Stack

## Overview

Two monitoring stacks run concurrently on the home server for comparison:

| Stack | Components | Domain | URL |
|---|---|---|---|
| `stacks/monitoring/` | Prometheus + Loki + Grafana | metrics.* | [https://metrics.${DOMAIN}](https://metrics.${DOMAIN}) |
| `stacks/victoria-metrics/` | VictoriaMetrics + VictoriaLogs + Grafana | metrics-vm.* | [https://metrics-vm.${DOMAIN}](https://metrics-vm.${DOMAIN}) |

**Both** serve the same scrape targets. Goal: measure resource consumption delta and
decide which stack to keep.

## Stack Comparison

### Prometheus + Loki (`stacks/monitoring/`)

```
loki (log storage) ← promtail (log collector) ← Docker containers
prometheus (metrics) ← node-exporter (host metrics), cadvisor (container metrics)
grafana (dashboard, metrics.* domain)
```

| Service | Memory limit | CPU limit | Purpose |
|---|---|---|---|
| prometheus | 512M | 0.5 | Metrics TSDB, PromQL |
| loki | 256M | 0.3 | Log storage, LogQL |
| promtail | 128M | 0.1 | Log collector from Docker |
| node-exporter | 64M | 0.1 | Host-level metrics |
| cadvisor | 128M | 0.3 | Per-container resource metrics |
| **Total** | **1.09G** | **1.3** | |

### VictoriaMetrics + VictoriaLogs (`stacks/victoria-metrics/`)

```
victoria-logs (log storage) ← promtail-vm (log collector) ← Docker containers
victoria-metrics (metrics TSDB) ← vmagent (scraper)
grafana-vm (dashboard, metrics-vm.* domain)
```

| Service | Memory limit | CPU limit | Replaces |
|---|---|---|---|
| victoria-metrics | 256M | 0.3 | Prometheus |
| vmagent | 128M | 0.2 | Prometheus scraper |
| victoria-logs | 256M | 0.3 | Loki |
| promtail-vm | 128M | 0.2 | Promtail |
| grafana-vm | 256M | 0.3 | Separate Grafana instance |
| **Total** | **1.02G** | **1.3** | |

### Comparison

| Aspect | Prometheus + Loki | VictoriaMetrics + VictoriaLogs |
|---|---|---|
| Maturity | Battle-tested, huge community | Newer (since 2018) |
| Query language | PromQL, LogQL | PromQL-compatible, LogsQL |
| Memory | Higher (~1.09G) | Lower (~1.02G claimed) |
| Disk | Higher | Lower (better compression) |
| Single binary | No (Java + Go) | Yes (Go) |
| HA story | Federated / Thanos | vmagent replication + vmstorage |

**Decision:** Run both for at least 2 weeks, compare docker stats. If VM stack
uses <70% resources AND dashboards work, migrate. Otherwise keep Prometheus+Loki.

See [victoria-metrics README](../stacks/victoria-metrics/README.md) for detailed
comparison methodology.

## Cross-Server Monitoring (Gatus)

Gatus runs on **home** and **cloud** servers. Each instance monitors the OTHER
servers' services — no single point of failure.

### Architecture

```
┌─────────────────┐         ┌─────────────────┐
│  home server    │         │  cloud server   │
│  Gatus instance │◄───────►│  Gatus instance │
│  uptime-home.*  │         │  uptime-cloud.* │
│                 │         │                 │
│ Monitors:       │         │ Monitors:       │
│ - cloud svcs    │         │ - home svcs     │
│ - offsite svcs  │         │ - offsite svcs  │
│ - external      │         │ - external      │
└────────┬────────┘         └────────┬────────┘
         │                           │
         └── ntfy alert ─────────────┘
```

### Home Gatus (`servers/home/configs/gatus.yml`)

- **Group: cloud** — mail (HTTPS, SMTP, IMAP), healthchecks, syncthing, ntfy,
  gatus, librespeed, traefik, stalwart, caldav, bulwark
- **Group: offsite** — traefik, syncthing
- **External** — neatsoft.dev

### Cloud Gatus (`servers/cloud/configs/gatus.yml`)

- **Group: home** — dash, vaultwarden, jellyfin, immich, adguard, transmission,
  open-webui, opencode-web, audiobookshelf, librespeed, metube, filebrowser,
  searxng, woodpecker, piped, syncthing, ntfy, gatus, traefik, monica, akaunting,
  grafana, ollama, traggo, usememos, reitti, mirotalk, gitea, authelia,
  grafana-vm, paperless, docker-registry, plausible, umami, caldiy, omni-tools
- **Group: offsite** — traefik, librespeed, syncthing
- **Group: external** — michaeldistel.com, controlforge.dev, kickingmiles.com,
  antonshubin.com, neatsoft.dev

### Health Probe Bridge

Services use a health probe endpoint pattern via `stacks/zond/`:

```
https://probe-home.${DOMAIN}/health/<service>
```

This bridges through auth layers and returns 200/503 purely for Gatus checks.

## Alerting

### ntfy

All Gatus alerts route through ntfy:

```yaml
alerting:
  ntfy:
    url: ${NTFY_URL}
    topic: ${NTFY_TOPIC}
    token: ${NTFY_TOKEN}
    priority: 3
    default-alert:
      enabled: true
      send-on-resolved: true
      failure-threshold: 3
      success-threshold: 2
```

- **Home ntfy**: `ntfy-home.${DOMAIN}`
- **Cloud ntfy**: `ntfy-cloud.${DOMAIN}`
- Offsite services use higher failure-threshold (9) due to intermittent RPi connectivity

### Authelia Monitoring Problem

Gatus checks behind Authelia see 302 (auth redirect) instead of 200 from the
actual service. Current workaround: accept 302 as proof the backend is reachable
at TCP level. A 502/503 would indicate the actual container is down.

Long-term: use `/api/verify?auth=basic` with a dedicated monitoring user for
true end-to-end checks. See [auth.md](auth.md) §Gatus Monitoring Problem.

## Missing Coverage

Per [improvements.md](improvements.md) §2.3, gaps include:

- Some stacks lack healthcheck endpoints
- Gatus coverage audit incomplete for all deployed services
- Offsite services have higher failure thresholds (9 vs 3) — may hide issues
- No Grafana alerting configured (only Gatus endpoint-level alerts)

## Dashboard

Dashboards available at:
- **Metrics (Prometheus+Loki)**: [https://metrics.${DOMAIN}](https://metrics.${DOMAIN}) — Authelia auth
- **Metrics (VictoriaMetrics)**: [https://metrics-vm.${DOMAIN}](https://metrics-vm.${DOMAIN}) — Authelia auth
- **Uptime (Home Gatus)**: [https://uptime-home.${DOMAIN}](https://uptime-home.${DOMAIN}) — public
- **Uptime (Cloud Gatus)**: [https://uptime-cloud.${DOMAIN}](https://uptime-cloud.${DOMAIN}) — public

## References

- [Gatus documentation](https://github.com/TwiN/gatus)
- [ntfy documentation](https://docs.ntfy.sh/)
- [VictoriaMetrics docs](https://docs.victoriametrics.com/)
- [Prometheus docs](https://prometheus.io/docs/)
- [Architecture overview](architecture.md)
- [VictoraMetrics stack README](../stacks/victoria-metrics/README.md)
