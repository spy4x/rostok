// Stack metadata for `traggo`.
//
// Self-hosted time tracker behind Traefik and the `authelia@file` middleware
// (host `time.${DOMAIN}`). Limits keep the values compose already falls back to.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "traggo",
  description: "Tag-based time tracker (traggo/server)",
  category: "productivity",
  requires: ["traefik"],
  variables: [
    {
      key: "TRAGGO_MEM_LIMIT",
      question: "Memory limit for the Traggo container?",
      default: "128M",
      required: true,
    },
    {
      key: "TRAGGO_CPU_LIMIT",
      question: "CPU limit for the Traggo container?",
      default: "0.2",
      required: true,
    },
  ],
} satisfies StackMeta
