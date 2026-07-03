# Monitoring Stack

## Overview

VictoriaMetrics won the bake-off against Prometheus + Loki. The old monitoring
stack (`stacks/monitoring/`) is removed. The victoria-metrics stack is primary,
with Grafana UI provided by the separate `stacks/grafana/` stack.

**Saving:** ~35% less memory and ~80% less CPU vs the previous Prometheus+Loki stack.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  victoria-metrics stack    │  grafana stack (separate)│
│                             │                          │
│  vmagent ──► victoria-metrics ──► Grafana (metrics.*) │
│  promtail ──► victoria-logs  ──► Grafana (logs)     │
│  node-exporter (host metrics)                        │
│  cadvisor (container metrics)                        │
└─────────────────────────────────────────────────────┘
```

All components are single-binary Go services (no JVM).

### Components

| Service | Role | Memory limit | CPU limit |
|---|---|---|---|
| `victoria-metrics` | Prometheus-compatible TSDB | 256M | 0.3 |
| `vmagent` | Metrics scraper | 128M | 0.2 |
| `victoria-logs` | Log database (LogsQL) | 256M | 0.3 |
| `promtail` | Log collector from Docker | 128M | 0.2 |
| `node-exporter` | Host-level metrics (CPU, mem, disk) | 64M | 0.1 |
| `cadvisor` | Per-container resource metrics | 128M | 0.3 |
| **Total** | | **960M** | **1.4** |

### Grafana (`stacks/grafana/`)

| Service | Role | Memory limit | CPU limit |
|---|---|---|---|
| `grafana` | Dashboards at metrics.* | 512M | 0.5 |

Datasources point to VictoriaMetrics (`hl-victoria-metrics:8428`) and
VictoriaLogs (`hl-victoria-logs:9428`) internally.

## URLs

- **Grafana dashboards**: [https://metrics.${DOMAIN}](https://metrics.${DOMAIN}) — Authelia auth
- **Uptime (Home Gatus)**: [https://uptime-home.${DOMAIN}](https://uptime-home.${DOMAIN}) — public
- **Uptime (Cloud Gatus)**: [https://uptime-cloud.${DOMAIN}](https://uptime-cloud.${DOMAIN}) — public

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

- **Group: home** — all deployed home services via probe bridge
- **Group: offsite** — traefik, librespeed, syncthing
- **Group: external** — michaeldistel.com, controlforge.dev, kickingmiles.com,
  antonshubin.com, neatsoft.dev

### Health Probe Bridge

Services use health probe endpoints via `stacks/zond/`:

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

## Scrape Targets

The VM stack scrapes itself:

- `hl-node-exporter:9100` — host-level metrics  
- `hl-cadvisor:8080` — container-level metrics
- `hl-victoria-metrics:8428` — VM self-metrics

## Missing Coverage

Per [improvements.md](improvements.md) §2.3, gaps include:

- Some stacks still lack compose-level healthchecks
- Gatus coverage audit incomplete for all deployed services
- Offsite services have higher failure thresholds (9 vs 3) — may hide issues
- No Grafana alerting configured (only Gatus endpoint-level alerts)

## References

- [VictoriaMetrics docs](https://docs.victoriametrics.com/)
- [VictoriaLogs docs](https://docs.victoriametrics.com/victorialogs/)
- [Gatus documentation](https://github.com/TwiN/gatus)
- [ntfy documentation](https://docs.ntfy.sh/)
- [VM stack README](../stacks/victoria-metrics/README.md)
- [Grafana stack](../stacks/grafana/)
- [Architecture overview](architecture.md)
