# VictoriaMetrics Stack

Primary observability stack. Provides metrics (VictoriaMetrics), logs (VictoriaLogs),
host/container-level exporters (node-exporter, cAdvisor), alerts to ntfy (vmalert, Alertmanager)
and dashboards (Grafana, on the host's loopback only).

Replaces the previous Prometheus + Loki stack with ~35% less memory and ~80% less CPU.

## Components

| Service            | Role                       | Memory limit | CPU limit |
| ------------------ | -------------------------- | ------------ | --------- |
| `victoria-metrics` | Prometheus-compatible TSDB | 256M         | 0.3       |
| `vmagent`          | Metrics scraper            | 128M         | 0.2       |
| `victoria-logs`    | Log database               | 256M         | 0.3       |
| `promtail`         | Log collector              | 128M         | 0.2       |
| `node-exporter`    | Host metrics               | 64M          | 0.1       |
| `cadvisor`         | Container metrics          | 256M         | 0.3       |
| `vmalert`          | Evaluates alert rules      | 128M         | 0.2       |
| `alertmanager`     | Sends alerts to ntfy       | 64M          | 0.1       |
| `grafana`          | Dashboards                 | 512M         | 0.5       |
| **Total**          |                            | **1792M**    | **2.2**   |

## Network and retention

The stack has no web UI and no Traefik route, and no service joins the shared `proxy` network.
VictoriaMetrics and VictoriaLogs take no password, and VictoriaLogs holds every container's log,
secrets some services print included. So each store is reachable only on the stack's own internal
networks:

- `metrics`: `hl-victoria-metrics:8428` with vmagent, node-exporter and cAdvisor;
- `logs`: `hl-victoria-logs:9428` with promtail and Grafana.

Two more networks are not internal and hold no store: `alerts` (vmalert and Alertmanager, which
sends to ntfy) and `grafana` (Grafana's host port and its plugin download).

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

## Alerts

vmalert evaluates two sets of rules and Alertmanager sends what fires to ntfy, resolved alerts
too, grouped by alert and server and repeated every 4 hours:

- **Host rules**, built into `compose.yml`: a scrape target down for 5 minutes, a disk under 10%
  free, memory under 5% available, a 15-minute load over twice the CPU count, and a temperature
  sensor above 90 °C.
- **Your own rules**: every `*.yml` file in the server's `configs/victoria-metrics/alerts/`
  folder, in vmalert's rule format. A project that ships its metrics into this stack puts its rule
  file there (Seed: `infra/configs/alerts.yml`), then restarts `hl-vmalert`.

Set `VICTORIA_METRICS_ALERT_NTFY_URL`, `VICTORIA_METRICS_ALERT_NTFY_TOPIC` and
`VICTORIA_METRICS_ALERT_NTFY_TOKEN` (a token that may publish to that topic). With the URL empty,
alerts stay in Alertmanager and nothing is sent.

## Grafana

Grafana listens on `127.0.0.1:3000` of the server (`VICTORIA_METRICS_GRAFANA_PORT`), never
behind Traefik. From another machine, open an SSH tunnel and browse `http://localhost:3000`:

```bash
ssh -L 3000:127.0.0.1:3000 <server>
```

Sign in as `admin` with `VICTORIA_METRICS_GRAFANA_PASSWORD`. Both stores are already set up as
data sources; Grafana downloads the VictoriaLogs plugin at its first start. Its data is in
`${VOLUMES_PATH}/grafana` and in the stack's backup.

## Querying from a shell

Both stores answer HTTP on their internal networks, so query them from inside a container:

```bash
# Metrics, PromQL
docker exec hl-victoria-metrics wget -qO- 'http://127.0.0.1:8428/api/v1/query?query=up'
# Logs, LogsQL: the last hour of one container's errors
docker exec hl-victoria-logs wget -qO- --post-data 'query=_time:1h container:"hl-traefik" error' http://127.0.0.1:9428/select/logsql/query
# What fires now
docker exec hl-vmalert wget -qO- http://127.0.0.1:8880/api/v1/alerts
```

## SELinux hosts

The stack starts on a Docker host that enforces SELinux (Fedora, RHEL) with no override.
node-exporter, cAdvisor and promtail mount host-system paths without `:z` and run with
`label=disable`, so they read host files under their own labels and Docker relabels nothing.

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

Declared in `+meta.ts`: image tags, the Grafana password and host address, and the three ntfy
settings for alerts. The stack has no Traefik route; it also reads the server-level keys
`DOCKER_GROUP_ID`, `VOLUMES_PATH` and `PATH_APPS`. The scrape and promtail
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
