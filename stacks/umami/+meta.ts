// Stack metadata for `umami`.
//
// Umami web analytics with its own PostgreSQL. Both secrets are generated.
//
// Two routers reach Umami: UMAMI_DOMAIN (the dashboard) and a `/umami/` path on the site you
// track, UMAMI_PROXY_DOMAIN and its www host, so the tracking script is served from the site's own
// domain (ad blockers and Safari ITP leave first-party paths alone). The defaults put that path on
// the server's apex domain; point them at another host if the site lives elsewhere.

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "umami",
  description: "Privacy-first web analytics with a PostgreSQL database (Umami)",
  category: "monitoring",
  requires: ["traefik"],
  variables: [
    {
      key: "UMAMI_IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "UMAMI_DOMAIN",
      question: "Public domain for the Umami dashboard?",
      default: "stats.${DOMAIN}",
      required: true,
    },
    {
      key: "UMAMI_PROXY_DOMAIN",
      question: "Site domain that proxies the tracking script under /umami/?",
      default: "${DOMAIN}",
      required: true,
    },
    {
      key: "UMAMI_PROXY_WWW_DOMAIN",
      question: "www host of that site?",
      default: "www.${DOMAIN}",
      required: true,
    },
    {
      key: "UMAMI_DB_PASSWORD",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "UMAMI_APP_SECRET",
      default: () => generatePassword(48),
      required: true,
      secret: true,
    },
  ],
} satisfies StackMeta
