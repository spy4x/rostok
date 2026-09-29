// Stack metadata for `oko`.
//
// Server-rendered dashboard that reads service health from Gatus badges. The image is
// `ghcr.io/spy4x/oko`, the author's own public project. Web UI at `dash.${DOMAIN}` behind
// Traefik, so the stack requires it. The service list lives in
// `${PATH_APPS}/configs/oko/config.json`, which the operator provides (see the README).
//
// Variable shape:
//   - OKO_UPTIME_HOSTS: comma-separated Gatus hosts. Default `uptime-${SERVER_NAME}.${DOMAIN}`,
//     the host a Gatus stack named after this server would use.
//
// Server-level vars (PROJECT, DOMAIN, PATH_APPS) intentionally NOT declared here.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "oko",
  description: "Server-rendered homelab dashboard fed by Gatus (spy4x/oko)",
  category: "monitoring",
  requires: ["traefik"],
  variables: [
    {
      key: "OKO_DOMAIN",
      question: "Public domain for the Oko dashboard?",
      default: "dash.${DOMAIN}",
      required: true,
    },
    {
      key: "OKO_UPTIME_HOSTS",
      question: "Gatus hosts to read badges from (comma-separated)?",
      default: "uptime-${SERVER_NAME}.${DOMAIN}",
      required: true,
    },
  ],
} satisfies StackMeta
