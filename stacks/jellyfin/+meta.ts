// Stack metadata for `jellyfin`.
//
// First 6 stacks tracked by the v1 catalog (docs/v1-cli.md §11, Phase 4).
// Jellyfin is a self-hosted media server. Compose currently doesn't
// reference ${IMAGE_TAG} (image tag is hardcoded in compose.yml) —
// declared per design convention for future use.
//
// Variable shape: single JELLYFIN_DOMAIN, default `movies.${DOMAIN}`.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "jellyfin",
  description: "Self-hosted media server (movies, TV, music, books)",
  category: "media",
  variables: [
    {
      key: "IMAGE_TAG",
      default: "latest",
      required: false,
    },
    {
      key: "JELLYFIN_DOMAIN",
      question: "Public domain for Jellyfin?",
      default: "movies.${DOMAIN}",
      required: true,
    },
  ],
} satisfies StackMeta
