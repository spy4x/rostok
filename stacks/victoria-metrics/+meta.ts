// Stack metadata for `victoria-metrics`.
//
// Metrics and logs: VictoriaMetrics, VictoriaLogs, vmagent, promtail, node-exporter, cAdvisor;
// alerts and dashboards on top: vmalert, Alertmanager (to ntfy), Grafana on localhost.
// No Traefik label, so no `requires: ["traefik"]`. The scrape and promtail configs come from
// the server's `configs/victoria-metrics/` folder (see the stack README), not from variables.
// Server-level keys are not declared here (see cli/server-keys.ts).

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "victoria-metrics",
  description:
    "Metrics, logs, alerts and dashboards (VictoriaMetrics, VictoriaLogs, vmalert, Grafana)",
  category: "monitoring",
  variables: [
    {
      key: "VICTORIA_METRICS_IMAGE_TAG",
      default: "v1.146.0",
      required: false,
    },
    {
      key: "VICTORIA_METRICS_VMAGENT_IMAGE_TAG",
      default: "v1.146.0",
      required: false,
    },
    {
      key: "VICTORIA_METRICS_LOGS_IMAGE_TAG",
      default: "v1.51.0",
      required: false,
    },
    {
      key: "VICTORIA_METRICS_PROMTAIL_IMAGE_TAG",
      default: "3.2.1",
      required: false,
    },
    {
      key: "VICTORIA_METRICS_NODE_EXPORTER_IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "VICTORIA_METRICS_GRAFANA_PASSWORD",
      question: "Grafana admin password?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "VICTORIA_METRICS_GRAFANA_PORT",
      question: "Host address of Grafana (keep it on 127.0.0.1)?",
      default: "127.0.0.1:3000",
      required: false,
    },
    {
      key: "VICTORIA_METRICS_ALERT_NTFY_URL",
      question: "ntfy server URL for alerts? Leave blank to keep alerts unsent",
      required: false,
    },
    {
      key: "VICTORIA_METRICS_ALERT_NTFY_TOPIC",
      question: "ntfy topic for alerts?",
      default: "alerts",
      required: false,
    },
    {
      key: "VICTORIA_METRICS_ALERT_NTFY_TOKEN",
      question: "ntfy access token that may publish to that topic? Leave blank for none",
      required: false,
      secret: true,
    },
    {
      key: "VICTORIA_METRICS_VMALERT_IMAGE_TAG",
      default: "v1.146.0",
      required: false,
    },
    {
      key: "VICTORIA_METRICS_ALERTMANAGER_IMAGE_TAG",
      default: "v0.34.1",
      required: false,
    },
    {
      key: "VICTORIA_METRICS_GRAFANA_IMAGE_TAG",
      default: "13.2.3",
      required: false,
    },
    {
      key: "VICTORIA_METRICS_CADVISOR_IMAGE_TAG",
      default: "v0.49.2",
      required: false,
    },
  ],
} satisfies StackMeta
