// Stack metadata for `gatus`.
//
// First 6 stacks tracked by the v1 catalog (docs/v1-cli.md §11, Phase 4).
// Gatus is a health-check status page. ntfy is used for alerting.
//
// Variable shape:
//   - GATUS_DOMAIN: single var, default `uptime.${DOMAIN}`. The dashboard
//     sits behind Traefik's basicauth middleware (or authelia) if the
//     operator adds it — gatus's own dashboard auth is intentionally not
//     exposed (Phase 4 user feedback: traefik/authelia owns auth).
//   - GATUS_BASIC_AUTH_BASE64: optional. Used by operator-written
//     `configs/gatus.yml` checks that probe an endpoint sitting behind
//     Traefik basic auth — Gatus sends it verbatim as
//     `Authorization: Basic ${GATUS_BASIC_AUTH_BASE64}`. Not gatus's own
//     dashboard auth (see above); base64 of `user:password`.
//   - GATUS_NTFY_*: optional. `stack add gatus -n` (no ntfy configured)
//     still deploys a working container — alerts are just off until these
//     are set. GATUS_CONFIG_PATH is gone: the stack ships a starter
//     config (stacks/gatus/config.yml, zero endpoints) that
//     `before.deploy.ts` replaces with `servers/<server>/configs/gatus.yml`
//     when the operator writes one. See the stack README.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "gatus",
  description: "Lightweight health-check status page with ntfy alerting",
  category: "monitoring",
  variables: [
    {
      key: "GATUS_IMAGE_TAG",
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
      key: "GATUS_BASIC_AUTH_BASE64",
      question:
        "Base64 of user:password for checks that probe an endpoint behind Traefik basic auth? Leave blank to skip",
      required: false,
      secret: true,
    },
    {
      key: "GATUS_NTFY_URL",
      question: "ntfy server URL for alerts (e.g. https://ntfy.example.com)? Leave blank to skip",
      // Optional: omitted from .env when blank, so `stack add gatus -n`
      // still deploys — alerting is just off until this is set.
      required: false,
    },
    {
      key: "GATUS_NTFY_TOPIC_UPTIME",
      question: "ntfy topic name for uptime alerts?",
      default: "alerts",
      required: true,
    },
    {
      key: "GATUS_NTFY_TOKEN_UPTIME",
      question: "ntfy access token for posting alerts? Leave blank to skip",
      required: false,
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
