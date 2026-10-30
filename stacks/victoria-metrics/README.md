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

## Network and retention

The stack has no web UI and no Traefik route, and no service joins the shared `proxy` network.
VictoriaMetrics and VictoriaLogs take no password, and VictoriaLogs holds every container's log,
secrets some services print included. So each store is reachable only on the stack's own internal
networks:

- `metrics`: `hl-victoria-metrics:8428` with vmagent, node-exporter and cAdvisor;
- `logs`: `hl-victoria-logs:9428` with promtail, nothing else.

To query a store from a dashboard in another stack, connect that container to the store's network
yourself (`docker network ls` shows it as `victoria-metrics_logs` or `victoria-metrics_metrics`),
and only that container. Anything on it reads all the data in the store.

Both stores keep data for 14 days (`--retentionPeriod=14d` in `compose.yml`). A number without a
unit means months.

## Setup

1. Create the two config files (see "Before the first deploy" below).
2. Deploy:

   ```bash
   rostok deploy <server>
   ```

## Scrape targets

- `hl-node-exporter:9100` — host-level metrics
- `hl-cadvisor:8080` — container-level metrics
- `hl-victoria-metrics:8428` — VM self-metrics

vmagent reaches only the `metrics` network, so a target in another stack is out of its reach
until you connect `hl-vmagent` to that stack's network.

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

## Image tags

Each image takes its tag from its own variable; unset, compose uses the default below.
Under `IMAGE_POLICY=pinned`, `rostok stack add` writes the exact version, and
`rostok images update` moves it (see [commands](../../docs/commands.md)).

| Variable                                   | Default    | Image                                                           |
| ------------------------------------------ | ---------- | --------------------------------------------------------------- |
| `VICTORIA_METRICS_IMAGE_TAG`               | `v1.146.0` | `victoriametrics/victoria-metrics` (service `victoria-metrics`) |
| `VICTORIA_METRICS_VMAGENT_IMAGE_TAG`       | `v1.146.0` | `victoriametrics/vmagent` (service `vmagent`)                   |
| `VICTORIA_METRICS_LOGS_IMAGE_TAG`          | `v1.51.0`  | `victoriametrics/victoria-logs` (service `victoria-logs`)       |
| `VICTORIA_METRICS_PROMTAIL_IMAGE_TAG`      | `3.2.1`    | `grafana/promtail` (service `promtail`)                         |
| `VICTORIA_METRICS_NODE_EXPORTER_IMAGE_TAG` | `latest`   | `prom/node-exporter` (service `node-exporter`)                  |
| `VICTORIA_METRICS_CADVISOR_IMAGE_TAG`      | `v0.49.2`  | `gcr.io/cadvisor/cadvisor` (service `cadvisor`)                 |
