// Stack metadata for `gatus`.
//
// First 6 stacks tracked by the v1 catalog (docs/v1-cli.md §11, Phase 4).
// Gatus is a health-check status page. ntfy is used for alerting.
//
// Variable shape:
//   - GATUS_DOMAIN: single var, default `uptime.${DOMAIN}`. The dashboard
//     sits behind Traefik's basicauth middleware (or authelia) — gatus's
//     own BASIC_AUTH_BASE64 option is intentionally not exposed (Phase 4
//     user feedback: traefik/authelia owns auth).
//   - GATUS_CONFIG_PATH: removed. Phase 5 wizard writes the config to
//     ./servers/<server>/configs/gatus.yml — fixed convention, no need
//     to expose this through the schema.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "gatus",
  description: "Lightweight health-check status page with ntfy alerting",
  category: "monitoring",
  variables: [
    {
      key: "IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "GATUS_DOMAIN",
      question: "Public domain for the status page?",
      default: "uptime.${DOMAIN}",
      required: true,
    },
    {
      key: "NTFY_URL",
      question: "ntfy server URL (e.g. https://ntfy.example.com)?",
      // Not marked secret: public URL. Auth goes in NTFY_TOKEN_UPTIME.
      required: true,
    },
    {
      key: "NTFY_TOPIC_UPTIME",
      question: "ntfy topic name for uptime alerts?",
      default: "alerts",
      required: true,
    },
    {
      key: "NTFY_TOKEN_UPTIME",
      question: "ntfy access token for posting alerts?",
      required: true,
      secret: true,
    },
    {
      key: "GATUS_CPU_LIMIT",
      question: "CPU limit for the Gatus container?",
      default: "0.2",
      required: true,
    },
    {
      key: "GATUS_MEM_LIMIT",
      question: "Memory limit for the Gatus container?",
      default: "128M",
      required: true,
    },
  ],
} satisfies StackMeta
