// Stack metadata for `zond`.
//
// Health-probe bridge: answers 200 or 503 for each container it is told to probe, so an external
// monitor (gatus on another server) can check services that have no public URL. The probe
// endpoint sits behind Traefik, so the stack requires it.
//
// Variable shape:
//   - ZOND_DOMAIN: default `probe-${SERVER_NAME}.${DOMAIN}` so several servers of one project
//     each get their own host (the value the compose file used to hardcode).
//   - ZOND_CPU_LIMIT / ZOND_MEM_LIMIT: same defaults as compose.
//
// The targets are not variables: `stacks/zond/config.yml` is a starter (one Traefik target) that
// `before.deploy.ts` replaces with `servers/<server>/configs/zond.yaml` when the operator writes
// one. See the stack README.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "zond",
  description: "Health-probe bridge: 200 or 503 per container for external monitors (spy4x/zond)",
  category: "monitoring",
  requires: ["traefik"],
  variables: [
    {
      key: "ZOND_DOMAIN",
      question: "Public domain for the probe endpoint?",
      default: "probe-${SERVER_NAME}.${DOMAIN}",
      required: true,
    },
    {
      key: "ZOND_CPU_LIMIT",
      question: "CPU limit for the Zond container?",
      default: "0.25",
      required: true,
    },
    {
      key: "ZOND_MEM_LIMIT",
      question: "Memory limit for the Zond container?",
      default: "64M",
      required: true,
    },
  ],
} satisfies StackMeta
