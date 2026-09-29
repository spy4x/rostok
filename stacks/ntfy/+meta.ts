// Stack metadata for `ntfy`.
//
// Self-hosted push notification service. Web UI and API sit behind Traefik, so the stack
// requires it. Access is deny-all by default: create users and tokens with `ntfy user` (see
// the README).
//
// Variable shape:
//   - NTFY_DOMAIN: default `ntfy.${DOMAIN}`, also the base URL clients publish to.
//   - NTFY_CPU_LIMIT / NTFY_MEM_LIMIT: same defaults as compose.
//
// Server-level vars (PROJECT, TIMEZONE, PUID, PGID, VOLUMES_PATH) intentionally NOT declared.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "ntfy",
  description: "Self-hosted push notifications (binwiederhier/ntfy)",
  category: "monitoring",
  requires: ["traefik"],
  variables: [
    {
      key: "NTFY_DOMAIN",
      question: "Public domain for ntfy?",
      default: "ntfy.${DOMAIN}",
      required: true,
    },
    {
      key: "NTFY_CPU_LIMIT",
      question: "CPU limit for the ntfy container?",
      default: "0.2",
      required: true,
    },
    {
      key: "NTFY_MEM_LIMIT",
      question: "Memory limit for the ntfy container?",
      default: "128M",
      required: true,
    },
  ],
} satisfies StackMeta
