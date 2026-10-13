// Stack metadata for `adguard`.
//
// AdGuard Home: network-wide DNS ad blocker. The web UI sits behind Traefik at ADGUARD_DOMAIN.
// DNS itself (53/tcp, 53/udp, 853/tcp) is published on ADGUARD_DNS_BIND only. The default,
// 127.0.0.1, answers the server itself and nobody else: a resolver open to the internet gets
// used for amplification attacks, so opening it is the user's explicit choice (see the README).
// The first-run setup wizard listens on 127.0.0.1:3000 only.

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
    {
      key: "ADGUARD_DNS_BIND",
      question:
        "Address the DNS ports listen on (127.0.0.1 = this server only, a LAN or VPN address of the server, 0.0.0.0 = every interface)?",
      default: "127.0.0.1",
      required: true,
    },
  ],
} satisfies StackMeta
