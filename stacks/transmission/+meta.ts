// Stack metadata for `transmission`.
//
// BitTorrent client with a web UI at `torrents.${DOMAIN}` behind Traefik. The Traefik router
// uses the `authelia@file` middleware, so the server also needs Authelia set up (see the
// README).
//
// Variable shape: the download folders compose mounts, PATH_MOVIES, PATH_SERIES, PATH_MUSIC,
// PATH_BOOKS and PATH_OTHER. They are shared by name with other stacks (jellyfin and
// filebrowser declare PATH_MUSIC too) and stay one value per key in the server's .env. Only
// the keys in SERVER_KEYS (cli/server-keys.ts) are written by `server create`; a PATH_* key
// that is not there is written by the first `stack add` that declares it, so each stack that
// mounts one declares it, with a default under VOLUMES_PATH.

import type { StackMeta } from "@rostok/cli"

export default {
  name: "transmission",
  description: "BitTorrent client with web UI (linuxserver/transmission)",
  category: "media",
  requires: ["traefik"],
  variables: [
    {
      key: "PATH_MOVIES",
      question: "Host path for downloaded movies?",
      default: "${VOLUMES_PATH}/movies",
      required: true,
    },
    {
      key: "PATH_SERIES",
      question: "Host path for downloaded series?",
      default: "${VOLUMES_PATH}/series",
      required: true,
    },
    {
      key: "PATH_MUSIC",
      question: "Host path for the music library?",
      default: "${VOLUMES_PATH}/music",
      required: true,
    },
    {
      key: "PATH_BOOKS",
      question: "Host path for downloaded books?",
      default: "${VOLUMES_PATH}/books",
      required: true,
    },
    {
      key: "PATH_OTHER",
      question: "Host path for other downloads?",
      default: "${VOLUMES_PATH}/other",
      required: true,
    },
  ],
} satisfies StackMeta
