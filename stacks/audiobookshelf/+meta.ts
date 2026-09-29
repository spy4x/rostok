// Stack metadata for `audiobookshelf`.
//
// Routes through Traefik at `books.${DOMAIN}`. Limits and host are fixed in compose.
// PATH_BOOKS is a shared server-level key that compose mounts; declared here like jellyfin does
// so a fresh server gets a value.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "audiobookshelf",
  description: "Audiobook and ebook server (advplyr/audiobookshelf)",
  category: "media",
  requires: ["traefik"],
  variables: [
    {
      key: "PATH_BOOKS",
      question: "Host path for the books library?",
      default: "${VOLUMES_PATH}/books",
      required: true,
    },
  ],
} satisfies StackMeta
