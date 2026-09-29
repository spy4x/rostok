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
  variables: [],
} satisfies StackMeta
