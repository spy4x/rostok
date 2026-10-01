// Stack metadata for `adguard`.
//
// AdGuard Home: network-wide DNS ad blocker. The web UI sits behind Traefik at ADGUARD_DOMAIN.
// DNS itself (53/tcp, 53/udp, 853/tcp) is published on the host, so port 53 must be free (on many
// distributions systemd-resolved holds it; see the README). The first-run setup wizard listens
// on 127.0.0.1:3000 only.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "adguard",
  description: "Network-wide ad and tracker blocking DNS server (AdGuard Home)",
  category: "network",
  requires: ["traefik"],
  variables: [
    {
      key: "ADGUARD_IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "ADGUARD_DOMAIN",
      question: "Public domain for the AdGuard Home web UI?",
      default: "dns.${DOMAIN}",
      required: true,
    },
  ],
} satisfies StackMeta
