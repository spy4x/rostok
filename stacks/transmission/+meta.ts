// Stack metadata for `transmission`.
//
// BitTorrent client with a web UI at `torrents.${DOMAIN}` behind Traefik. The Traefik router
// uses the `authelia@file` middleware, so the server also needs Authelia set up (see the
// README). No stack-owned variables: the download folders are the server-level `PATH_MOVIES`,
// `PATH_SERIES`, `PATH_MUSIC`, `PATH_BOOKS` and `PATH_OTHER`.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "transmission",
  description: "BitTorrent client with web UI (linuxserver/transmission)",
  category: "media",
  requires: ["traefik"],
  variables: [],
} satisfies StackMeta
