// Stack metadata for `wireguard`.
//
// WireGuard VPN server (linuxserver/wireguard). It listens on UDP 51820 and is not routed
// through Traefik, so the stack requires nothing.
//
// Variable shape:
//   - WIREGUARD_DOMAIN: public host clients connect to. Default `vpn.${DOMAIN}`. The DNS record
//     must point at the server itself (no CDN proxy in front of a UDP port).
//   - WIREGUARD_PEERS: number of peers, or a comma-separated list of peer names.
//   - WIREGUARD_DNS: resolvers handed to clients, same default as compose.
//
// Server-level vars (TIMEZONE, PUID, PGID, VOLUMES_PATH) intentionally NOT declared here.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "wireguard",
  description: "WireGuard VPN server (linuxserver/wireguard)",
  category: "infra",
  variables: [
    {
      key: "WIREGUARD_DOMAIN",
      question: "Public host name clients connect to?",
      default: "vpn.${DOMAIN}",
      required: true,
    },
    {
      key: "WIREGUARD_PEERS",
      question: "Peers to create: a number, or comma-separated names?",
      default: "phone,laptop",
      required: true,
    },
    {
      key: "WIREGUARD_DNS",
      question: "DNS servers handed to clients (comma-separated)?",
      default: "1.1.1.1,8.8.8.8,9.9.9.9",
      required: true,
    },
  ],
} satisfies StackMeta
