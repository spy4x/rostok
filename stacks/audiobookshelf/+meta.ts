// Stack metadata for `audiobookshelf`.
//
// Routes through Traefik at `books.${DOMAIN}`. Limits and host are fixed in compose.
// Server-level keys are not declared here (see cli/server-keys.ts).

import type { StackMeta } from "@rostok/cli"

export default {
  name: "audiobookshelf",
  description: "Audiobook and ebook server (advplyr/audiobookshelf)",
  category: "media",
  requires: ["traefik"],
  variables: [],
} satisfies StackMeta
