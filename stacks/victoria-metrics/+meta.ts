// Stack metadata for `victoria-metrics`.
//
// Metrics and logs: VictoriaMetrics, VictoriaLogs, vmagent, promtail, node-exporter, cAdvisor.
// No Traefik label, so no `requires: ["traefik"]`. The scrape and promtail configs come from
// the server's `configs/victoria-metrics/` folder (see the stack README), not from variables.
// Server-level keys are not declared here (see cli/server-keys.ts).

import type { StackMeta } from "@rostok/cli"

export default {
  name: "victoria-metrics",
  description: "Metrics and logs stack (VictoriaMetrics, VictoriaLogs, vmagent, promtail)",
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
      key: "VICTORIA_METRICS_CADVISOR_IMAGE_TAG",
      default: "v0.49.2",
      required: false,
    },
  ],
} satisfies StackMeta
