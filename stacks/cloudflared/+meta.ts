// Stack metadata for `cloudflared`.
//
// Cloudflare Tunnel connector. It only dials out to Cloudflare, so there is no Traefik router,
// no domain and no `requires`. The tunnel token comes from the Cloudflare dashboard (Zero Trust,
// Networks, Tunnels), so it has no default: `stack add` asks for it.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "cloudflared",
  description: "Cloudflare Tunnel connector: expose services without open ports",
  category: "network",
  variables: [
    {
      key: "CLOUDFLARED_IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "CLOUDFLARED_TUNNEL_TOKEN",
      question: "Cloudflare Tunnel token (from the Cloudflare Zero Trust dashboard)?",
      required: true,
      secret: true,
    },
    {
      key: "CLOUDFLARED_CPU_LIMIT",
      question: "CPU limit for the cloudflared container?",
      default: "0.5",
      required: true,
    },
    {
      key: "CLOUDFLARED_MEM_LIMIT",
      question: "Memory limit for the cloudflared container?",
      default: "256M",
      required: true,
    },
  ],
} satisfies StackMeta
