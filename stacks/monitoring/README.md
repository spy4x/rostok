# Monitoring

Observability stack — metrics, logs, and container monitoring.

## Components

| Service           | Role                                                 |
| ----------------- | ---------------------------------------------------- |
| **Prometheus**    | Metrics storage and query engine (scrapes exporters) |
| **Loki**          | Log aggregation (receives from Promtail)             |
| **Promtail**      | Log collector (reads Docker container logs)          |
| **Node Exporter** | Host-level metrics (CPU, memory, disk, network)      |
| **cAdvisor**      | Container-level resource metrics                     |

## Access

- Grafana dashboard: `https://metrics.${DOMAIN}`
- Prometheus API: internal on default network

## Dashboards

Grafana is provisioned with dashboards for host and container metrics. Data sources:

- Prometheus (short-term metrics)
- VictoriaMetrics (long-term metrics)
- Loki (logs)

## Resources

- [Prometheus Docs](https://prometheus.io/docs/)
- [Grafana Loki](https://grafana.com/oss/loki/)
- [cAdvisor](https://github.com/google/cadvisor)
