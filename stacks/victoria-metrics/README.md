# VictoriaMetrics Stack

Primary observability stack. Provides metrics (VictoriaMetrics), logs (VictoriaLogs),
and host/container-level exporters (node-exporter, cAdvisor).

Replaces the previous Prometheus + Loki stack with ~35% less memory and ~80% less CPU.

## Components

| Service            | Role                       | Memory limit | CPU limit |
| ------------------ | -------------------------- | ------------ | --------- |
| `victoria-metrics` | Prometheus-compatible TSDB | 256M         | 0.3       |
| `vmagent`          | Metrics scraper            | 128M         | 0.2       |
| `victoria-logs`    | Log database               | 256M         | 0.3       |
| `promtail`         | Log collector              | 128M         | 0.2       |
| `node-exporter`    | Host metrics               | 64M          | 0.1       |
| `cadvisor`         | Container metrics          | 128M         | 0.3       |
| **Total**          |                            | **960M**     | **1.4**   |

## URLs

- **Grafana**: `https://metrics.${DOMAIN}` (provided by `stacks/grafana`)
- **VM API**: `http://hl-victoria-metrics:8428` (internal)
- **VL API**: `http://hl-victoria-logs:9428` (internal)

## Setup

1. Add env vars to `servers/home/.env`:

   ```bash
   #region Grafana
   GRAFANA_ADMIN_PASSWORD=YOUR_SECURE_PASSWORD
   #endregion Grafana
   ```

2. Deploy:

   ```bash
   deno task deploy home victoria-metrics
   ```

3. Open `https://metrics.${DOMAIN}` and check the VictoriaMetrics + VictoriaLogs datasources work.

## Scrape targets

- `hl-node-exporter:9100` — host-level metrics
- `hl-cadvisor:8080` — container-level metrics
- `hl-victoria-metrics:8428` — VM self-metrics

## References

- [VictoriaMetrics](https://docs.victoriametrics.com/)
- [VictoriaLogs](https://docs.victoriametrics.com/victorialogs/)
- [VMAgent](https://docs.victoriametrics.com/vmagent.html)

## Variables

Declared in `+meta.ts`. The stack has no variables of its own and no Traefik route; it reads only
server-level keys (`DOCKER_GROUP_ID`, `VOLUMES_PATH`, `PATH_APPS`). The scrape and promtail
configs live in the server's `configs/victoria-metrics/` folder.

## Before the first deploy

Compose mounts two config files from `${PATH_APPS}/configs/victoria-metrics/`. The stack does not
create them. If one is missing, Docker creates a root-owned directory in its place and `vmagent`
or `promtail` restarts forever. Create both in `servers/<server>/configs/victoria-metrics/`
before deploying.

`scrape.yml`, the scrape targets:

```yaml
global:
  scrape_interval: 30s
scrape_configs:
  - job_name: node
    static_configs:
      - targets: ["hl-node-exporter:9100"]
  - job_name: cadvisor
    static_configs:
      - targets: ["hl-cadvisor:8080"]
  - job_name: victoria-metrics
    static_configs:
      - targets: ["hl-victoria-metrics:8428"]
```

`promtail.yml`, docker container logs shipped to VictoriaLogs:

```yaml
server:
  disable: true
positions:
  filename: /tmp/positions.yaml
clients:
  - url: http://hl-victoria-logs:9428/insert/loki/api/v1/push
scrape_configs:
  - job_name: docker
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 15s
    relabel_configs:
      - source_labels: ["__meta_docker_container_name"]
        regex: "/(.*)"
        target_label: container
```
