# Grafana

Metrics dashboard and observability — visualizes Prometheus, Loki, and VictoriaMetrics data.

## Features

- Pre-configured datasources (Prometheus, Loki, VictoriaMetrics)
- Provisioned dashboards for system and container metrics
- Auth proxy enabled for Authelia SSO
- Alerting and annotations

## Access

Web UI: `https://metrics.${DOMAIN}` (protected by Authelia SSO)

## Data Sources

| Source          | Type    | Purpose                   |
| --------------- | ------- | ------------------------- |
| Prometheus      | Metrics | Host + container metrics  |
| VictoriaMetrics | Metrics | Long-term metrics storage |
| Loki            | Logs    | Container log aggregation |

## Resources

- [Grafana Documentation](https://grafana.com/docs/)
- [Grafana GitHub](https://github.com/grafana/grafana)
