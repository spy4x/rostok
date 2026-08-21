// Stack metadata for `filebrowser`.
//
// First 6 stacks tracked by the v1 catalog (docs/v1-cli.md §11, Phase 4).
// Filebrowser is a self-hosted file manager.
//
// Variable shape: single FILEBROWSER_DOMAIN, default `files.${DOMAIN}`.
//
// Server-level vars (TIMEZONE, PUID, PGID) intentionally NOT declared
// here — they live in `.env.root` and are populated by the wizard's
// server-create step. Phase 5 wizard propagates them to each stack's
// `.env` so compose sees them via its standard env loading.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "filebrowser",
  description: "Self-hosted web-based file manager",
  category: "storage",
  variables: [
    {
      key: "IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "FILEBROWSER_DOMAIN",
      question: "Public domain for Filebrowser?",
      default: "files.${DOMAIN}",
      required: true,
    },
  ],
} satisfies StackMeta
