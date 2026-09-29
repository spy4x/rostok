// Stack metadata for `syncthing`.
//
// Continuous file sync between servers (backup replication). Web UI sits
// behind Traefik, so the stack requires it.
//
// Variable shape:
//   - SYNCTHING_DOMAIN: default `sync-${SERVER_NAME}.${DOMAIN}` so several
//     servers of one project each get their own host.
//   - SYNCTHING_API_KEY: secret, generated at `stack add`. Syncthing takes
//     it verbatim as STGUIAPIKEY, and `before.deploy.ts` refuses a missing,
//     placeholder or short (< 16 chars) key. `generatePassword(32)` is
//     URL-safe base64, so it passes and needs no quoting in `.env`.
//   - SYNCTHING_CPU_LIMIT / SYNCTHING_MEM_LIMIT: same defaults as compose.
//
// Server-level vars (PUID, PGID) intentionally NOT declared here — same
// convention as filebrowser. Host paths are not variables: they live in
// the per-server `compose-override/syncthing.yml`, and folders/devices in
// `configs/syncthing.yml` (see the stack README).

import type { StackMeta } from "@rostok/cli"
import { generatePassword } from "@rostok/cli"

export default {
  name: "syncthing",
  description: "Continuous file sync between servers (syncthing/syncthing)",
  category: "infra",
  requires: ["traefik"],
  variables: [
    {
      key: "SYNCTHING_DOMAIN",
      question: "Public domain for the Syncthing web UI?",
      default: "sync-${SERVER_NAME}.${DOMAIN}",
      required: true,
    },
    {
      key: "SYNCTHING_API_KEY",
      question: "Syncthing API key (auto-generated at deploy time)?",
      default: () => generatePassword(32),
      required: true,
      secret: true,
    },
    {
      key: "SYNCTHING_CPU_LIMIT",
      question: "CPU limit for the Syncthing container?",
      default: "1",
      required: true,
    },
    {
      key: "SYNCTHING_MEM_LIMIT",
      question: "Memory limit for the Syncthing container?",
      default: "1024M",
      required: true,
    },
  ],
} satisfies StackMeta
