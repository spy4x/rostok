// Stack metadata for `usememos`.
//
// Routes through Traefik at `notes.${DOMAIN}`.
// Server-level keys are not declared here (see cli/server-keys.ts).

import type { StackMeta } from "@rostok/cli"

export default {
  name: "usememos",
  description: "Self-hosted notes (usememos/memos)",
  category: "productivity",
  requires: ["traefik"],
  variables: [
    {
      key: "USEMEMOS_DOMAIN",
      question: "Public domain for Memos?",
      default: "notes.${DOMAIN}",
      required: true,
    },
  ],
} satisfies StackMeta
